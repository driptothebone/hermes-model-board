"""Authenticated native dashboard routes, strictly local/in-process.

No legacy board import, provider credential reads, lifecycle calls, core mutation,
or HTTP read/check/unconditional-write emulation. Core lock access is deliberately
version-sensitive; catalog review will report private-import warnings.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import httpx
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from hermes_cli import config_backend as cb

# Load our own engine the same way Hermes loads a dashboard API file; never alter
# sys.path or patch a core module. This also works outside a source checkout.
ENGINE_PATH = Path(__file__).resolve().parent.parent / 'host.py'
ENGINE_NAME = 'hermes_model_board_own_engine'
if ENGINE_NAME not in sys.modules:
    spec = importlib.util.spec_from_file_location(ENGINE_NAME, ENGINE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError('Model Board engine unavailable')
    module = importlib.util.module_from_spec(spec)
    sys.modules[ENGINE_NAME] = module
    spec.loader.exec_module(module)
engine = sys.modules[ENGINE_NAME]
router = APIRouter()
REASON = 'Requires an authenticated, initialized, in-process Hermes dashboard with the local-file config backend.'
BOARDS = {}
SAFE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')


def native_core(request):
    # Inspect only a host already running. Importing web_server initializes it.
    core = sys.modules.get('hermes_cli.web_server')
    if core is None or getattr(core, 'app', None) is not request.app:
        raise HTTPException(503, REASON + ' Isolated plugin workers are unsupported.')
    core._require_token(request)
    # Profile-scoped tickets do not grant machine-wide authority to profiles[].
    if (getattr(request.state, 'native_http_principal', None)
            or getattr(request.state, 'hosted_http_authenticated', False)
            or getattr(request.state, 'token_authenticated', False)):
        raise HTTPException(403, 'Fleet operations require machine-dashboard browser authority, not a profile/service ticket')
    if not getattr(cb, '_BOOTSTRAPPED', False) or cb.get_config_backend().name != 'file':
        raise HTTPException(503, 'Initialized local-file backend required; no bootstrap or remote fallback')
    lock = getattr(cb, 'CONFIG_MUTATION_LOCK', None) or getattr(core, '_CONFIG_MUTATION_LOCK', None)
    if lock is None or not hasattr(lock, '__enter__'):
        raise HTTPException(503, 'Canonical host mutation lock unavailable')
    return lock


async def host_json(request, path, params=None):
    if path not in ('/api/profiles', '/api/model/options'):
        raise HTTPException(503, 'Unsupported host operation')
    # Only incoming management-session headers, never provider credentials.
    headers = {k:v for k,v in request.headers.items() if k.lower() in ('host', 'cookie', 'x-hermes-session-token')}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=request.app),
                                 base_url=str(request.base_url), headers=headers) as client:
        response = await client.get(path, params=params)
    if response.status_code != 200:
        raise HTTPException(503, 'Host profile/model API unavailable; no credential fallback')
    try:
        return response.json()
    except ValueError:
        raise HTTPException(503,'Host API returned invalid JSON') from None


async def native_board(request):
    lock = native_core(request)
    payload = await host_json(request, '/api/profiles')
    rows = payload.get('profiles', [])
    if not isinstance(rows,list) or not rows or len(rows)>64:
        raise HTTPException(503, 'Host profile roster unavailable or exceeds candidate bound')
    paths = {}
    for row in rows:
        if not isinstance(row,dict):
            raise HTTPException(503, 'Invalid host profile binding')
        name,path = row.get('name'),row.get('path')
        if not isinstance(name,str) or not SAFE_ID.fullmatch(name) or not isinstance(path,str) or not Path(path).is_absolute() or name in paths:
            raise HTTPException(503, 'Unsupported host profile binding')
        paths[name] = Path(path) / 'config.yaml'
    session = getattr(request.state,'session',None)
    principal = ('session',getattr(session,'org_id',''),getattr(session,'user_id','')) if session is not None else ('local-owner',)
    # Bind local previews to the current authenticated management session without
    # storing its cookie/token. Gated sessions also include the verified identity.
    credential = request.headers.get('x-hermes-session-token','') + '\0' + request.headers.get('cookie','')
    principal += (hashlib.sha256(credential.encode()).hexdigest(),)
    key = (id(request.app),principal,tuple(sorted((p,str(v)) for p,v in paths.items())))
    catalog = {}
    for p in paths:
        payload = await host_json(request,'/api/model/options',{'profile':p,'explicit_only':'true'})
        providers = payload.get('providers',[])
        if not isinstance(providers,list):
            raise HTTPException(503,'Host model catalog unavailable')
        entries=[]
        for provider in providers:
            if not isinstance(provider,dict):continue
            slug=provider.get('slug')
            for model in provider.get('models',[]) if isinstance(provider.get('models',[]),list) else []:
                mid=model.get('id') if isinstance(model,dict) else model
                if isinstance(slug,str) and isinstance(mid,str) and slug and mid and engine.safe_value('provider',slug) and engine.safe_value('model',mid):
                    entries.append({'provider':slug,'model':mid})
        catalog[p]=entries
    with lock:
        if key not in BOARDS:
            if len(BOARDS)>=16:raise HTTPException(503,'Candidate authority cache full')
            BOARDS[key]=engine.HostBoard(paths,catalog,lock,principal=principal)
        board=BOARDS[key];board.catalog=catalog
    return board


async def dispatch(request,action):
    data = {}
    try:
        if action != 'state':
            if request.headers.get('content-type','').split(';')[0] != 'application/json':
                raise HTTPException(415,'JSON required')
            raw=await request.body()
            if len(raw)>65536:raise HTTPException(413,'Request too large')
            try:data=json.loads(raw)
            except (ValueError,UnicodeError):raise HTTPException(422,'Invalid JSON') from None
            if not isinstance(data,dict):raise HTTPException(422,'Object required')
        board=await native_board(request)
        if action=='state':return await run_in_threadpool(board.state)
        if action=='preview':return await run_in_threadpool(board.preview,data)
        if set(data)!={'draft','token','confirmed'}:raise HTTPException(422,'Exact apply envelope required')
        return await run_in_threadpool(lambda:board.apply(data['draft'],data['token'],confirmed=data['confirmed']))
    except engine.BoardError as error:
        raise HTTPException(error.status,error.detail) from None


@router.get('/state')
async def state(request: Request):
    try:return await dispatch(request,'state')
    except HTTPException as error:
        if error.status_code!=503:raise
        return {'available':False,'fixture':False,'profiles':[],'reason':error.detail}


@router.post('/preview')
async def preview(request: Request):return await dispatch(request,'preview')


@router.post('/apply')
async def apply_changes(request: Request):return await dispatch(request,'apply')
