"""In-process local-file routing engine; no credential reads or legacy adapter.

The caller must supply host-authorized paths, host-owned model catalogs and the
actual core mutation lock. This engine never discovers a profile or credentials.
"""
import copy
import hashlib
import json
from pathlib import Path
import re
import secrets
import time
from hermes_cli import config_backend as cb
from hermes_cli.config_defaults import DEFAULT_CONFIG
from hermes_constants import VALID_REASONING_EFFORTS

ROUTE_ID = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_./:@+\[\]-]{0,199}$')
SECRET_PREFIX = re.compile(r'^(?:sk[-_]|xai-|hf_|gh[pousr]_)', re.I)
EFFORTS = tuple(VALID_REASONING_EFFORTS)
AUX_DEFAULTS = DEFAULT_CONFIG.get('auxiliary', {})

def safe_value(key, value):
    if key.endswith('context_length'):
        return isinstance(value,int) and not isinstance(value,bool) and value > 0
    if key.endswith('reasoning_effort'):
        return value is False or (isinstance(value,str) and value in ('', *EFFORTS))
    return isinstance(value,str) and (value == '' or bool(ROUTE_ID.fullmatch(value)) and '://' not in value and not SECRET_PREFIX.match(value) and not (':' in value and '@' in value))

TASK = re.compile(r'^[A-Za-z][A-Za-z0-9_]{0,79}$')
OVERRIDES = {'base_url','api_url','api_key','api','key_env','api_key_env','api_mode','extra_headers'}

class BoardError(Exception):
    def __init__(self,status,detail):
        super().__init__(detail)
        self.status,self.detail=status,detail

def field(doc,key):
    node=doc
    for part in key.split('.'):
        if not isinstance(node,dict) or part not in node:return {'present':False}
        node=node[part]
    return {'present':True,'value':node}

def put(doc,key,value):
    parts=key.split('.');node=doc
    for part in parts[:-1]:
        node=node.setdefault(part,{})
        if not isinstance(node,dict):raise BoardError(422,'Routing block is not a mapping')
    if value is None:node.pop(parts[-1],None)
    else:node[parts[-1]]=value

def safe_routes(doc):
    out={'model':{},'agent':{},'delegation':{},'auxiliary':{}}
    specs=[('model',('provider','default')),('agent',('reasoning_effort',)),('delegation',('provider','model','reasoning_effort'))]
    aux=doc.get('auxiliary',{})
    if isinstance(aux,dict):specs += [('auxiliary.'+k,('provider','model','reasoning_effort')) for k in aux if isinstance(k,str) and k in AUX_DEFAULTS and TASK.fullmatch(k)]
    for base,keys in specs:
        for key in keys:
            val=field(doc,base+'.'+key)
            if val['present']:
                put(out,base+'.'+key,val['value'] if safe_value(key,val['value']) else '[withheld: unsupported route value]')
    return out

class HostBoard:
    def __init__(self,paths,catalog,lock,*,principal):
        self.paths={p:Path(v) for p,v in paths.items()}
        self.catalog,self.lock,self.principal=copy.deepcopy(catalog),lock,principal
        self.instance=secrets.token_hex(32);self.previews={}

    def read(self,p):
        path=self.paths[p]
        if not path.is_absolute() or path.name!='config.yaml' or path.resolve()!=path:
            raise BoardError(503,'Profile location changed or unsupported; reload')
        try:
            doc=cb.read_config_doc(path)
        except Exception:
            raise BoardError(503,'Profile configuration unreadable; no repair attempted') from None
        if not isinstance(doc,dict):raise BoardError(503,'Profile configuration is not a mapping')
        return doc

    def revision(self,doc):
        return hashlib.sha256((self.instance+json.dumps(doc,sort_keys=True)).encode()).hexdigest()

    def row(self,p):
        doc=self.read(p)
        return {'profile':p,'models':[{'provider':m['provider'],'model':m['model']} for m in self.catalog.get(p,[]) if isinstance(m,dict) and safe_value('provider',m.get('provider')) and safe_value('model',m.get('model'))],'routes':safe_routes(doc),'revision':self.revision(doc)}

    def state(self):
        with self.lock:
            return {'available':True,'fixture':False,'authority':'Authenticated local host; same-process mutation lock, not a fleet transaction.',
                    'inventory_provenance':'Hermes /api/model/options; credentials remain with host',
                    'unsupported':['federation','jobs','remote config','isolated plugin workers','explicit endpoint/auth overrides'],
                    'profiles':[self.row(p) for p in self.paths]}

    def validate(self,d):
        required={'profiles','targets','route','provider','model','effort','expected_revisions'}
        if not isinstance(d,dict) or set(d)!=required:raise BoardError(422,'Invalid draft fields')
        ps,ts=d['profiles'],d['targets']
        if not isinstance(ps,list) or not ps or len(ps)>64 or any(not isinstance(p,str) or p not in self.paths for p in ps) or len(set(ps))!=len(ps):raise BoardError(422,'Select exact unique authorized profiles')
        if not isinstance(ts,list) or not ts or len(ts)>64 or any(not isinstance(t,str) for t in ts) or len(set(ts))!=len(ts):raise BoardError(422,'Select unique supported targets')
        for p in ps:
            aux=self.read(p).get('auxiliary',{});allowed={'main','delegation','auxiliary.vision'}
            if isinstance(aux,dict):allowed|={'auxiliary.'+k for k in aux if isinstance(k,str) and k in AUX_DEFAULTS and TASK.fullmatch(k)}
            if any(t not in allowed for t in ts):raise BoardError(422,'Auxiliary target not declared in every selected profile')
        route,effort=d['route'],d['effort']
        if route not in ('keep','explicit','inherit','auto') or effort not in (None,'',*EFFORTS):raise BoardError(422,'Invalid route or effort')
        if any(not isinstance(d[k],str) for k in ('provider','model')):raise BoardError(422,'Exact provider/model strings required')
        if route=='explicit':
            if not safe_value('provider',d['provider']) or not safe_value('model',d['model']):raise BoardError(422,'Unsupported provider/model identifiers')
            pair={'provider':d['provider'],'model':d['model']}
            if any(pair not in self.catalog.get(p,[]) for p in ps):raise BoardError(422,'Selection not in every selected profile host catalog')
        elif d['provider'] or d['model']:raise BoardError(422,'Nonexplicit routes require empty provider/model')
        if ('main' in ts and route in ('inherit','auto')) or ('delegation' in ts and route=='auto'):raise BoardError(422,'Unsupported route for selected target')
        if route=='keep' and effort is None:raise BoardError(422,'No requested change')
        revs=d['expected_revisions']
        if not isinstance(revs,dict) or set(revs)!=set(ps) or any(not isinstance(v,str) for v in revs.values()):raise BoardError(422,'Exact profile revisions required')

    def plan(self,doc,d):
        after,changes=copy.deepcopy(doc),[]
        for target in d['targets']:
            base='model' if target=='main' else target;mk='default' if target=='main' else 'model';eb='agent' if target=='main' else target
            block=field(doc,base)
            if block['present'] and not isinstance(block['value'],dict):raise BoardError(422,'Routing block is not a mapping')
            if d['route']!='keep' and block['present'] and OVERRIDES.intersection(block['value']):raise BoardError(422,'Explicit endpoint/auth overrides require host-managed setup; candidate will not change them')
            if target.startswith('auxiliary.') and d['effort'] is not None:
                task=target.split('.',1)[1]
                definition=AUX_DEFAULTS.get(task)
                if not isinstance(definition,dict) or 'reasoning_effort' not in definition:
                    raise BoardError(422,'Selected auxiliary task does not honor its own reasoning effort; no fields changed')
                if task=='background_review':
                    main=doc.get('model',{})
                    candidate={'provider':d['provider'],'model':d['model']} if d['route']=='explicit' else (block['value'] if block['present'] else {})
                    if d['route'] in ('inherit','auto') or candidate.get('provider') in (None,'','main','auto') or (candidate.get('provider'),candidate.get('model'))==(main.get('provider'),main.get('default')):
                        raise BoardError(422,'Background review inherits main reasoning on this route; effort-only change refused')
            updates={}
            if d['route']=='explicit':updates.update({base+'.provider':d['provider'],base+'.'+mk:d['model']})
            elif d['route'] in ('inherit','auto'):
                updates[base+'.provider']=None if target=='delegation' else ('main' if d['route']=='inherit' else 'auto')
                updates[base+'.'+mk]=None if target=='delegation' else ''
            if target=='main' and d['route']=='explicit' and block['present'] and 'context_length' in block['value'] and (block['value'].get('provider'),block['value'].get('default'))!=(d['provider'],d['model']):
                updates['model.context_length']=None
            if d['effort'] is not None:updates[eb+'.reasoning_effort']=d['effort'] or None
            for key,value in updates.items():
                old=field(doc,key);new={'present':False} if value is None else {'present':True,'value':value}
                if old['present'] and not safe_value(key,old['value']):raise BoardError(422,'Stored route has unsupported value; withheld, not changed')
                if old!=new:changes.append({'field':key,'before':old,'after':new});put(after,key,value)
        return after,changes

    def preview(self,d):
        with self.lock:
            self.validate(d);plans={}
            for p in d['profiles']:
                doc=self.read(p)
                if self.revision(doc)!=d['expected_revisions'][p]:raise BoardError(409,'Profile changed; reload and preview again')
                after,changes=self.plan(doc,d);plans[p]={'before':self.revision(doc),'changes':changes}
            now=time.monotonic();self.previews={t:v for t,v in self.previews.items() if now-v['at']<600}
            if len(self.previews)>=128:raise BoardError(429,'Too many pending previews')
            token=secrets.token_urlsafe(32);self.previews[token]={'at':now,'draft':copy.deepcopy(d),'plans':plans}
            return {'fixture':False,'token':token,'profiles':[{'profile':p,'changes':v['changes']} for p,v in plans.items()],
                    'warning':'Sequential local-profile saves. Same-process conflict protection, not cross-process locking or a fleet transaction.'}

    def apply(self,d,token,*,confirmed):
        with self.lock:
            if confirmed is not True or not isinstance(token,str) or token not in self.previews:raise BoardError(409,'Explicit confirmation and current preview required')
            pending=self.previews[token]
            if time.monotonic()-pending['at']>600 or d!=pending['draft']:raise BoardError(409,'Preview changed or expired')
            self.validate(d)
            for p,plan in pending['plans'].items():
                if self.revision(self.read(p))!=plan['before']:
                    del self.previews[token];raise BoardError(409,'Stale preview: selected profile changed; nothing written')
            del self.previews[token];results=[]
            for p,plan in pending['plans'].items():
                try:
                    doc=self.read(p)
                    if self.revision(doc)!=plan['before']:
                        results.append({'profile':p,'state':'conflict','detail':'Profile changed; not written'});continue
                    after,changes=self.plan(doc,d)
                    if changes!=plan['changes']:
                        results.append({'profile':p,'state':'conflict','detail':'Plan changed; not written'});continue
                    if changes:cb.write_config_document(self.paths[p],after)
                    saved=self.read(p)
                    if any(field(saved,c['field'])!=c['after'] for c in changes):results.append({'profile':p,'state':'uncertain','detail':'Readback mismatch; reload, never replay'})
                    else:results.append({'profile':p,'state':'applied' if changes else 'unchanged','readback':safe_routes(saved)})
                except Exception:results.append({'profile':p,'state':'uncertain','detail':'Save/readback failed; reload, never replay'})
            ok=all(r['state'] in ('applied','unchanged') for r in results)
            return {'fixture':False,'ok':ok,'partial':not ok and any(r['state']=='applied' for r in results),'profiles':results}
