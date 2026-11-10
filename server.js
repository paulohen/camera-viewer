// Painel de câmeras IP (RTSP) na rede local, com várias câmeras.
// Converte o RTSP de cada câmera em MJPEG via ffmpeg e serve a página que mostra, grava e configura tudo.
// Sem dependências npm; requer apenas o ffmpeg no PATH (ou FFMPEG_PATH).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Registry, BRANDS, publicCamera, normalizeInput, migrateFromConfig } = require('./camera-registry');
const { Live, probe } = require('./live');

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json não encontrado. Copie config.example.json para config.json e preencha.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const port = config.port || 8090;
// Cada câmera tem uma subpasta própria (<id>) em dataDir, gateDir e carsDir. Rostos (faces, candidates) valem para todas.
const dataDir = process.env.DATA_DIR || config.dataDir || '/data'; // fotos salvas pelo analyzer: <camera>/dd-mm-yyyy/HH-MM-SS_rotulo.jpg
const candDir = process.env.CANDIDATES_DIR || '/candidates'; // faces_candidates/ do analyzer (revisão)
const carsDir = process.env.CARS_DIR || '/cars';              // carros cadastrados, zona da garagem e capturas, por câmera (compartilhado com o analyzer)
const facesDir = process.env.FACES_DIR || '/faces';          // faces/: rostos usados no reconhecimento
const gateDir = process.env.GATE_DIR || '/gate';              // calibração/estado do portão, por câmera (compartilhado com o analyzer)
const camerasDir = process.env.CAMERAS_DIR || '/cameras';    // cameras.json (câmeras e senhas) e settings.json (ajustes globais)
const ffmpegBin = process.env.FFMPEG_PATH || config.ffmpegPath || 'ffmpeg';

const registry = new Registry(camerasDir);
const live = new Live({ ffmpegBin, config });
try { migrateFromConfig(registry, config, gateDir); } catch (e) { console.error('Não foi possível migrar a câmera do config.json:', e.message); }

// ---- Login do painel (HTTP Basic). Ativo quando config.json tem "auth": {user, passwordHash}; veja set-password.sh ----
const crypto = require('crypto');
const failures = new Map(); // ip -> {count, until}
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();

function passwordOk(user, pass) {
  const [alg, saltHex, hashHex] = String(config.auth.passwordHash).split(':');
  if (alg !== 'scrypt') return false;
  const given = crypto.scryptSync(pass, Buffer.from(saltHex, 'hex'), 32);
  const userOk = crypto.timingSafeEqual(sha(user), sha(config.auth.user));
  return crypto.timingSafeEqual(given, Buffer.from(hashHex, 'hex')) && userOk;
}

function authorized(req, res) {
  if (!config.auth || !config.auth.passwordHash) return true;
  const ip = req.socket.remoteAddress;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600' });
    res.end('Muitas tentativas erradas. Aguarde alguns minutos.');
    return false;
  }
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i >= 0 && passwordOk(decoded.slice(0, i), decoded.slice(i + 1))) { failures.delete(ip); return true; }
    const previous = f && !(f.until && f.until <= Date.now()) ? f.count : 0; // bloqueio já expirado zera a contagem
    const count = previous + 1;
    failures.set(ip, { count, until: count >= 10 ? Date.now() + 10 * 60 * 1000 : 0 }); // 10 erros => bloqueia 10 min
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Camera", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Autenticação necessária');
  return false;
}

// ---- Gravações (fotos geradas pelo analyzer) ----
const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
const FILE_RE = /^\d{2}-\d{2}-\d{2}_[A-Za-z0-9+._-]+\.jpg$/;
const dateKey = (d) => d.split('-').reverse().join(''); // dd-mm-yyyy -> yyyymmdd

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(data));
}

// "pessoa-maria" -> "maria"; "pessoa-desconhecida" -> "desconhecida"; "pessoa" -> "pessoa (sem identificação)"; "carro" -> "carro"
function tagsOf(file) {
  let labels = file.replace(/^\d{2}-\d{2}-\d{2}_/, '').replace(/\.jpg$/, '').split('+');
  if (labels.length > 1) labels = labels.filter((l) => l !== 'pessoa'); // fotos antigas traziam "pessoa" + nome
  return labels.map((l) => (l === 'pessoa' ? 'pessoa (sem identificação)' : l.startsWith('pessoa-') ? l.slice(7) : l));
}

// Dias com fotos de UMA câmera: [{date, count}]
async function camDays(cam) {
  const days = [];
  for (const d of await fs.promises.readdir(path.join(dataDir, cam.id)).catch(() => [])) {
    if (!DATE_RE.test(d)) continue;
    const files = await fs.promises.readdir(path.join(dataDir, cam.id, d)).catch(() => []);
    days.push({ date: d, count: files.filter((f) => FILE_RE.test(f)).length });
  }
  return days.filter((d) => d.count > 0);
}

// ?camera=<id> => dias dessa câmera; ?camera=all => soma das câmeras.
async function listDays(cams) {
  const byDate = new Map();
  for (const cam of cams) for (const d of await camDays(cam)) byDate.set(d.date, (byDate.get(d.date) || 0) + d.count);
  return [...byDate].map(([date, count]) => ({ date, count })).sort((a, b) => dateKey(b.date).localeCompare(dateKey(a.date)));
}

async function camEvents(cam, date) {
  const dayDir = path.join(dataDir, cam.id, date);
  const files = (await fs.promises.readdir(dayDir).catch(() => [])).filter((f) => FILE_RE.test(f));
  const events = await Promise.all(files.map(async (file) => {
    const ev = { camera: cam.id, cameraName: cam.nome, file, time: file.slice(0, 8).replace(/-/g, ':'), tags: tagsOf(file) };
    try {
      const j = JSON.parse(await fs.promises.readFile(path.join(dayDir, file.replace(/\.jpg$/, '.json')), 'utf8'));
      if (j.segundos_em_cena !== undefined) ev.seconds = j.segundos_em_cena;
      const face = (j.detections || []).find((d) => d.face);
      if (face) ev.faceConf = face.conf;
      if (j.evento) ev.evento = j.evento;   // eventos da garagem: parou | saiu
    } catch (e) { /* sem JSON: mostra só o que está no nome do arquivo */ }
    return ev;
  }));
  return events;
}

async function listEvents(cams, date) {
  const events = (await Promise.all(cams.map((cam) => camEvents(cam, date)))).flat();
  return events.sort((a, b) => b.file.localeCompare(a.file) || a.camera.localeCompare(b.camera));
}

// ---- Revisão de rostos candidatos ----
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CAND_FOLDER_RE = /^(_desconhecida|[a-z0-9][a-z0-9-]{0,39})$/;
const CAND_FILE_RE = /^[A-Za-z0-9._-]+\.(jpg|jpeg|png)$/i;

async function listCandidates() {
  const folders = [];
  for (const d of await fs.promises.readdir(candDir).catch(() => [])) {
    if (!CAND_FOLDER_RE.test(d)) continue;
    const files = (await fs.promises.readdir(path.join(candDir, d)).catch(() => [])).filter((f) => CAND_FILE_RE.test(f));
    if (files.length) folders.push({ name: d, files: files.sort().reverse() });
  }
  folders.sort((a, b) => (a.name === '_desconhecida') - (b.name === '_desconhecida') || a.name.localeCompare(b.name));
  const people = (await fs.promises.readdir(facesDir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && SLUG_RE.test(d.name)).map((d) => d.name).sort();
  return { folders, people };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) { reject(new Error('corpo grande demais')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Só aceita POST JSON vindo desta mesma página (o Content-Type JSON força preflight em outros sites).
function sameOriginJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

function candItems(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 500) throw new Error('itens inválidos');
  return items.map((i) => {
    if (!CAND_FOLDER_RE.test(i.folder) || !CAND_FILE_RE.test(i.file)) throw new Error('item inválido');
    return { folder: i.folder, file: i.file, src: path.join(candDir, i.folder, i.file) };
  });
}

async function approveCandidates(body) {
  const items = candItems(body);
  if (!SLUG_RE.test(body.target || '')) throw new Error('nome inválido (use letras minúsculas, números e hífen)');
  const dstDir = path.join(facesDir, body.target);
  await fs.promises.mkdir(dstDir, { recursive: true });
  let moved = 0;
  for (const it of items) {
    let name = it.file;
    if (fs.existsSync(path.join(dstDir, name))) name = `${Date.now()}_${name}`;
    // copia + apaga (e não rename) porque faces/ e faces_candidates/ são montagens diferentes
    await fs.promises.copyFile(it.src, path.join(dstDir, name), fs.constants.COPYFILE_EXCL);
    await fs.promises.unlink(it.src);
    moved++;
  }
  return { moved };
}

async function discardCandidates(body) {
  let removed = 0;
  for (const it of candItems(body)) {
    await fs.promises.unlink(it.src);
    removed++;
  }
  return { removed };
}

// ---- Portão ----
const num = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error('valor fora do intervalo'); return n; };

// Arquivos de uma câmera ficam em gate/<id>/; faces_status.json (de todas as câmeras) fica na raiz de gate/.
const gateDirOf = (cam) => path.join(gateDir, cam.id);
function readGateFile(cam, name) {
  try { return JSON.parse(fs.readFileSync(path.join(cam ? gateDirOf(cam) : gateDir, name), 'utf8')); } catch (e) { return null; }
}
function writeGateFile(cam, name, data) {
  const dst = path.join(gateDirOf(cam), name);
  fs.mkdirSync(gateDirOf(cam), { recursive: true });
  fs.writeFileSync(dst + '.tmp', JSON.stringify(data, null, 1));
  fs.renameSync(dst + '.tmp', dst);
}

// Aceita "11 99999-9999", "(11) 99999-9999", "+55 11 99999-9999"... e devolve "+5511999999999".
function normalizePhone(v) {
  let d = String(v).replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d; // sem DDI: assume Brasil
  if (d.length < 12 || d.length > 15) throw new Error('telefone inválido: use DDI + DDD + número, ex.: +55 11 99999-9999');
  return '+' + d;
}

function saveGateConfig(body, cam) {
  const cfg = readGateFile(cam, 'gate.json') || {};
  if (body.roi !== undefined) {
    if (body.roi === null) cfg.roi = null;
    else {
      const r = body.roi;
      const roi = { x: num(r.x, 0, 1), y: num(r.y, 0, 1), w: num(r.w, 0.01, 1), h: num(r.h, 0.01, 1) };
      if (roi.x + roi.w > 1.0001 || roi.y + roi.h > 1.0001) throw new Error('região fora da imagem');
      cfg.roi = roi;
    }
  }
  const time = (v) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error('horário inválido (use HH:MM)'); return v; };
  if (body.unknownEnabled !== undefined) cfg.unknownEnabled = !!body.unknownEnabled;
  if (body.unknownFrom !== undefined) cfg.unknownFrom = time(body.unknownFrom);
  if (body.unknownTo !== undefined) cfg.unknownTo = time(body.unknownTo);
  if (body.unknownCooldownMin !== undefined) cfg.unknownCooldownMin = num(body.unknownCooldownMin, 0, 1440);
  if (body.unknownIncludeNoFace !== undefined) cfg.unknownIncludeNoFace = !!body.unknownIncludeNoFace;
  if (body.healthEnabled !== undefined) cfg.healthEnabled = !!body.healthEnabled;
  if (body.cameraDownMin !== undefined) cfg.cameraDownMin = num(body.cameraDownMin, 1, 1440);
  if (body.threshold !== undefined) cfg.threshold = num(body.threshold, 0.05, 0.99);
  if (body.alertAfterMin !== undefined) cfg.alertAfterMin = num(body.alertAfterMin, 0.5, 1440);
  if (body.repeatMin !== undefined) cfg.repeatMin = num(body.repeatMin, 0, 1440);
  if (body.notifyClosed !== undefined) cfg.notifyClosed = !!body.notifyClosed;
  if (body.enabled !== undefined) cfg.enabled = !!body.enabled;
  writeGateFile(cam, 'gate.json', cfg);
  return cfg;
}

const GATE_CMDS = ['add_closed', 'clear_refs', 'calibrate_open', 'test_alert', 'test_telegram'];
function gateCommand(body, cam) {
  if (!GATE_CMDS.includes(body.cmd)) throw new Error('comando inválido');
  if (fs.existsSync(path.join(gateDirOf(cam), 'cmd.json'))) throw new Error('aguarde: o comando anterior ainda está sendo processado');
  writeGateFile(cam, 'cmd.json', { cmd: body.cmd });
  return { queued: body.cmd };
}

// ---- Cadastro de pessoas (pasta faces/) ----
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const safeImage = (f) => typeof f === 'string' && f.length > 0 && f.length <= 160 && !/[\/\\\u0000-\u001f]/.test(f) && !f.startsWith('.') && IMG_RE.test(f);
const peopleMetaPath = path.join(facesDir, 'people.json'); // fica fora das subpastas, então o reconhecimento não o lê
const slugify = (v) => String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}
function readPeopleMeta() { try { return JSON.parse(fs.readFileSync(peopleMetaPath, 'utf8')); } catch (e) { return {}; } }
function writePeopleMeta(meta) { fs.writeFileSync(peopleMetaPath + '.tmp', JSON.stringify(meta, null, 1)); fs.renameSync(peopleMetaPath + '.tmp', peopleMetaPath); }

async function listPeople() {
  const meta = readPeopleMeta();
  const status = readGateFile(null, 'faces_status.json') || {};   // o analyzer diz se achou rosto em cada foto
  const dirs = (await fs.promises.readdir(facesDir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && SLUG_RE.test(d.name)).map((d) => d.name).sort();
  const people = [];
  for (const slug of dirs) {
    const files = (await fs.promises.readdir(path.join(facesDir, slug)).catch(() => [])).filter(safeImage).sort();
    const cand = (await fs.promises.readdir(path.join(candDir, slug)).catch(() => [])).filter((f) => CAND_FILE_RE.test(f)).length;
    const m = meta[slug] || {};
    people.push({ slug, nome: m.nome || slug, obs: m.obs || '', candidates: cand,
      photos: files.map((f) => ({ file: f, ok: status[`${slug}/${f}`] ?? null })) });
  }
  return people;
}

async function savePerson(body) {
  const nome = String(body.nome || '').trim().slice(0, 60);
  const obs = String(body.obs || '').trim().slice(0, 300);
  const slug = body.slug || slugify(nome);
  if (!SLUG_RE.test(slug)) throw new Error('nome inválido: use letras e números');
  const dir = path.join(facesDir, slug);
  const exists = fs.existsSync(dir);
  if (!exists && body.slug) throw new Error('pessoa não encontrada');
  await fs.promises.mkdir(dir, { recursive: true });
  const meta = readPeopleMeta();
  meta[slug] = { nome: nome || (meta[slug] && meta[slug].nome) || slug, obs };
  writePeopleMeta(meta);
  return { slug, created: !exists };
}

async function deletePhoto(body) {
  if (!SLUG_RE.test(body.slug || '') || !safeImage(body.file)) throw new Error('foto inválida');
  await fs.promises.unlink(path.join(facesDir, body.slug, body.file));
  return { ok: true };
}

async function deletePerson(body) {
  if (!SLUG_RE.test(body.slug || '')) throw new Error('pessoa inválida');
  const dir = path.join(facesDir, body.slug);
  for (const f of await fs.promises.readdir(dir).catch(() => [])) if (safeImage(f)) await fs.promises.unlink(path.join(dir, f));
  await fs.promises.rmdir(dir).catch(() => { throw new Error('a pasta tem arquivos que não são fotos; remova-os à mão'); });
  const meta = readPeopleMeta(); delete meta[body.slug]; writePeopleMeta(meta);
  return { ok: true };
}

// Recebe UMA foto por requisição (corpo = bytes da imagem). Cabeçalhos: X-Upload: 1, X-Slug, X-Filename (url-encoded).
function handleUpload(req, res) {
  const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: msg })); req.resume(); };
  if (req.headers['x-upload'] !== '1' || !originOk(req)) return fail(403, 'forbidden');
  const slug = req.headers['x-slug'] || '';
  if (!SLUG_RE.test(slug) || !fs.existsSync(path.join(facesDir, slug))) return fail(400, 'pessoa não encontrada');
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', (c) => { size += c.length; if (size > 10 * 1024 * 1024) tooBig = true; else chunks.push(c); });
  req.on('end', async () => {
    if (tooBig) return fail(413, 'foto maior que 10 MB');
    const b = Buffer.concat(chunks);
    const ext = b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg'
      : b.length > 12 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'png'
      : b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
    if (!ext) return fail(400, 'arquivo não é uma imagem JPG, PNG ou WEBP');
    let base = 'foto';
    try { base = slugify(decodeURIComponent(req.headers['x-filename'] || '').replace(/\.[^.]*$/, '')) || 'foto'; } catch (e) { /* nome ruim: usa "foto" */ }
    const file = `${Date.now()}_${base}.${ext}`;
    try { await fs.promises.writeFile(path.join(facesDir, slug, file), b, { flag: 'wx' }); }
    catch (e) { return fail(500, 'não foi possível gravar a foto'); }
    sendJson(res, { file });
  });
}

// ---- Carros e garagem ----
// Cada câmera tem a sua garagem e os seus carros: cars/<id>/cars.json, cars/<id>/<carro>/, cars/<id>/_capturas/
const carsDirOf = (cam) => path.join(carsDir, cam.id);
const CARS_DEFAULT = { garage: null, stopSec: 20, threshold: 0.40, alertUnknown: false, cars: {} };
function readCarsCfg(cam) { try { return { ...CARS_DEFAULT, ...JSON.parse(fs.readFileSync(path.join(carsDirOf(cam), 'cars.json'), 'utf8')) }; } catch (e) { return { ...CARS_DEFAULT, cars: {} }; } }
function writeCarsCfg(cam, cfg) {
  const file = path.join(carsDirOf(cam), 'cars.json');
  fs.mkdirSync(carsDirOf(cam), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 1));
  fs.renameSync(file + '.tmp', file);
}
const CAR_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;  // "_capturas" começa com "_": nunca confunde com um carro

async function listCars(cam) {
  const dir = carsDirOf(cam);
  const cfg = readCarsCfg(cam);
  const slugs = new Set(Object.keys(cfg.cars));
  for (const d of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) if (d.isDirectory() && CAR_SLUG_RE.test(d.name)) slugs.add(d.name);
  const cars = [];
  for (const slug of [...slugs].sort()) {
    const photos = (await fs.promises.readdir(path.join(dir, slug)).catch(() => [])).filter(safeImage).sort();
    const o = cfg.cars[slug] || {};
    cars.push({ slug, nome: o.nome || slug, alertOnPark: !!o.alertOnPark, alertOnLeave: !!o.alertOnLeave, photos });
  }
  const captures = (await fs.promises.readdir(path.join(dir, '_capturas')).catch(() => [])).filter(safeImage).sort().reverse();
  const { cars: _omit, ...settings } = cfg;
  return { camera: cam.id, settings, cars, captures, state: readGateFile(cam, 'cars_state.json') };
}

async function saveCarsConfig(body, cam) {
  const cfg = readCarsCfg(cam);
  if (body.garage !== undefined) {
    if (body.garage === null) cfg.garage = null;
    else {
      const r = body.garage;
      const g = { x: num(r.x, 0, 1), y: num(r.y, 0, 1), w: num(r.w, 0.02, 1), h: num(r.h, 0.02, 1) };
      if (g.x + g.w > 1.0001 || g.y + g.h > 1.0001) throw new Error('zona fora da imagem');
      cfg.garage = g;
    }
  }
  if (body.stopSec !== undefined) cfg.stopSec = num(body.stopSec, 5, 600);
  if (body.threshold !== undefined) cfg.threshold = num(body.threshold, 0.3, 0.99);
  if (body.alertUnknown !== undefined) cfg.alertUnknown = !!body.alertUnknown;
  await fs.promises.mkdir(carsDirOf(cam), { recursive: true });
  writeCarsCfg(cam, cfg);
  return cfg;
}

async function saveCar(body, cam) {
  const cfg = readCarsCfg(cam);
  const nome = String(body.nome || '').trim().slice(0, 60);
  const slug = body.slug || slugify(nome);
  if (!CAR_SLUG_RE.test(slug)) throw new Error('nome inválido: use letras e números');
  const exists = !!cfg.cars[slug] || fs.existsSync(path.join(carsDirOf(cam), slug));
  if (body.slug && !exists) throw new Error('carro não encontrado');
  if (!exists && !nome) throw new Error('informe o nome do carro');
  await fs.promises.mkdir(path.join(carsDirOf(cam), slug), { recursive: true });
  const old = cfg.cars[slug] || {};
  cfg.cars[slug] = {
    nome: nome || old.nome || slug,
    alertOnPark: body.alertOnPark !== undefined ? !!body.alertOnPark : (old.alertOnPark ?? true),   // carro novo: avisa ao parar
    alertOnLeave: body.alertOnLeave !== undefined ? !!body.alertOnLeave : !!old.alertOnLeave,
  };
  writeCarsCfg(cam, cfg);
  return { slug, created: !exists };
}

async function deleteCar(body, cam) {
  if (!CAR_SLUG_RE.test(body.slug || '')) throw new Error('carro inválido');
  const dir = path.join(carsDirOf(cam), body.slug);
  for (const f of await fs.promises.readdir(dir).catch(() => [])) if (safeImage(f)) await fs.promises.unlink(path.join(dir, f));
  await fs.promises.rmdir(dir).catch(() => { /* já não existia */ });
  const cfg = readCarsCfg(cam); delete cfg.cars[body.slug]; writeCarsCfg(cam, cfg);
  return { ok: true };
}

async function deleteCarPhoto(body, cam) {
  if (!CAR_SLUG_RE.test(body.slug || '') || !safeImage(body.file)) throw new Error('foto inválida');
  await fs.promises.unlink(path.join(carsDirOf(cam), body.slug, body.file));
  return { ok: true };
}

async function carsCapture(body, cam) {
  if (fs.existsSync(path.join(carsDirOf(cam), 'cmd.json'))) throw new Error('aguarde: o comando anterior ainda está sendo processado');
  await fs.promises.mkdir(path.join(carsDirOf(cam), '_capturas'), { recursive: true });
  fs.writeFileSync(path.join(carsDirOf(cam), 'cmd.json'), JSON.stringify({ cmd: 'capture' }));
  return { queued: true };
}

async function assignCapture(body, cam) {
  if (!safeImage(body.file)) throw new Error('captura inválida');
  const src = path.join(carsDirOf(cam), '_capturas', body.file);
  if (!fs.existsSync(src)) throw new Error('captura não encontrada');
  const slug = body.slug || slugify(body.nome || '');
  if (!CAR_SLUG_RE.test(slug)) throw new Error('escolha um carro ou informe um nome');
  const cfg = readCarsCfg(cam);
  if (!cfg.cars[slug] && !fs.existsSync(path.join(carsDirOf(cam), slug))) await saveCar({ nome: body.nome }, cam);
  await fs.promises.mkdir(path.join(carsDirOf(cam), slug), { recursive: true });
  await fs.promises.rename(src, path.join(carsDirOf(cam), slug, `${Date.now()}_${body.file}`));
  return { slug };
}

async function discardCapture(body, cam) {
  if (!safeImage(body.file)) throw new Error('captura inválida');
  await fs.promises.unlink(path.join(carsDirOf(cam), '_capturas', body.file));
  return { ok: true };
}

const CARS_POST = { '/api/cars/config': saveCarsConfig, '/api/cars/save': saveCar, '/api/cars/delete': deleteCar,
  '/api/cars/delete-photo': deleteCarPhoto, '/api/cars/capture': carsCapture, '/api/cars/assign': assignCapture, '/api/cars/discard': discardCapture };

// ---- Câmeras (painel de administração) ----
const CAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Hora da última atualização do analyzer para a câmera: diz se a análise dela está viva.
function analyzerAge(cam) {
  if (cam.analyze === false || cam.enabled === false) return null;
  const st = readGateFile(cam, 'state.json');
  return st && st.updatedAt ? Math.max(0, Math.round(Date.now() / 1000 - st.updatedAt)) : null;
}

function listCameras() {
  return {
    cameras: registry.list().map((c) => ({ ...publicCamera(c), analyzerAge: analyzerAge(c) })),
    brands: Object.fromEntries(Object.entries(BRANDS).map(([k, b]) => [k, b.label])),
  };
}

function saveCamera(body) {
  const cam = registry.save(body);
  return { camera: publicCamera(cam) };
}

function deleteCamera(body) {
  registry.remove(String(body.id || ''));
  live.forget(body.id);
  return { ok: true };   // fotos, portão e carros da câmera ficam nas pastas dela (cameraImages/<id>, gate/<id>, cars/<id>)
}

let probing = false;
async function testCamera(body) {
  if (probing) throw new Error('aguarde: outro teste de câmera está em andamento');
  const old = body.id ? registry.get(String(body.id)) : null;
  const cam = normalizeInput({ ...body, nome: body.nome || 'teste' }, old);
  probing = true;
  try {
    const r = await probe(ffmpegBin, cam.rtspUrl);
    return r.ok ? { ok: true, ms: r.ms, image: 'data:image/jpeg;base64,' + r.jpeg.toString('base64') } : { ok: false, error: r.error };
  } finally { probing = false; }
}

// ---- Ajustes globais e WhatsApp (WAHA) ----
function getSettings() {
  const s = registry.settings();
  const alerts = config.alerts || {};
  return {
    phone: s.phone || alerts.whatsappPhone || '',
    phoneFromPanel: !!s.phone,
    whatsappAlertEnabled: s.whatsappAlertEnabled !== false,
    whatsappDownMin: s.whatsappDownMin ?? 5,
    whatsappConfigured: !!(alerts.wahaUrl && alerts.wahaApiKey),
    telegramConfigured: !!(alerts.telegramBotToken && alerts.telegramChatId),
  };
}

function saveSettings(body) {
  const patch = {};
  if (body.phone !== undefined) patch.phone = body.phone === '' ? undefined : normalizePhone(body.phone); // vazio: volta ao telefone do config.json
  if (body.whatsappAlertEnabled !== undefined) patch.whatsappAlertEnabled = !!body.whatsappAlertEnabled;
  if (body.whatsappDownMin !== undefined) patch.whatsappDownMin = num(body.whatsappDownMin, 1, 1440);
  registry.saveSettings(patch);
  return getSettings();
}

// Chamada ao WAHA (WhatsApp). O WAHA só aceita conexões desta máquina; o painel é quem fala com ele e repassa o QR code.
function waha(pathAndQuery, accept = 'application/json') {
  const a = config.alerts || {};
  if (!a.wahaUrl || !a.wahaApiKey) return Promise.reject(new Error('WhatsApp não configurado no config.json (alerts.wahaUrl e alerts.wahaApiKey)'));
  const u = new URL(pathAndQuery, a.wahaUrl.replace(/\/?$/, '/'));
  return new Promise((resolve, reject) => {
    const r = http.get(u, { headers: { 'X-Api-Key': a.wahaApiKey, Accept: accept }, timeout: 8000 }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, type: resp.headers['content-type'] || '', body: Buffer.concat(chunks) }));
    });
    r.on('timeout', () => r.destroy(new Error('o WAHA não respondeu')));
    r.on('error', (e) => reject(new Error('não foi possível falar com o WAHA (o contêiner camera-waha está ligado?)')));
  });
}
const wahaSession = () => encodeURIComponent((config.alerts && config.alerts.wahaSession) || 'default');

async function whatsappStatus() {
  const s = getSettings();
  const out = { configured: s.whatsappConfigured, phone: s.phone, telegramConfigured: s.telegramConfigured, status: null, me: null };
  if (!s.whatsappConfigured) return out;
  try {
    const r = await waha(`api/sessions/${wahaSession()}`);
    if (r.status === 200) {
      const j = JSON.parse(r.body.toString('utf8'));
      out.status = j.status || 'desconhecido';
      if (j.me && j.me.id) out.me = String(j.me.id).replace(/@.*/, '').replace(/:\d+$/, '');
    } else out.status = r.status === 404 ? 'NAO_CRIADA' : `erro ${r.status}`;
  } catch (e) { out.status = 'indisponível'; out.error = e.message; }
  return out;
}

// Inicia a sessão do WhatsApp quando ela está parada ou não existe (a página chama ao pedir o QR code).
async function whatsappStart() {
  const a = config.alerts || {};
  const sess = (a.wahaSession) || 'default';
  const post = (p, body) => new Promise((resolve, reject) => {
    const u = new URL(p, a.wahaUrl.replace(/\/?$/, '/'));
    const data = body ? JSON.stringify(body) : '';
    const r = http.request(u, { method: 'POST', timeout: 8000, headers: { 'X-Api-Key': a.wahaApiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (resp) => {
      resp.resume(); resp.on('end', () => resolve(resp.statusCode));
    });
    r.on('timeout', () => r.destroy(new Error('o WAHA não respondeu')));
    r.on('error', () => reject(new Error('não foi possível falar com o WAHA')));
    r.end(data);
  });
  const st = await whatsappStatus();
  if (st.status === 'STOPPED') await post(`api/sessions/${encodeURIComponent(sess)}/start`);
  else if (st.status === 'NAO_CRIADA') await post('api/sessions', { name: sess, start: true });
  return whatsappStatus();
}

// ---- Roteamento ----
const jsonHead = { 'Content-Type': 'application/json; charset=utf-8' };
function fail(res, code, msg) { res.writeHead(code, jsonHead); res.end(JSON.stringify({ error: msg })); }
const failFor = (res) => (e) => fail(res, e.code === 'NO_CAMERA' ? 404 : 400, e.message);

// POST JSON: só desta mesma página; `fn(body, cam)` recebe a câmera escolhida em body.camera quando withCamera.
function handlePost(req, res, fn, withCamera) {
  if (!sameOriginJson(req)) { res.writeHead(403); res.end('forbidden'); return; }
  readJson(req).then((body) => fn(body, withCamera ? registry.resolve(body.camera) : undefined)).then((r) => sendJson(res, r)).catch(failFor(res));
}
// GET JSON: fn() devolve (ou promete) os dados.
function handleGet(res, fn) {
  Promise.resolve().then(fn).then((d) => sendJson(res, d)).catch((e) => (e.code === 'NO_CAMERA' ? fail(res, 404, e.message) : (console.error(e), fail(res, 500, 'erro interno'))));
}
function sendFile(res, file, type, cache) {
  const stream = fs.createReadStream(file);
  stream.on('error', () => { res.writeHead(404); res.end('Not found'); });
  stream.on('open', () => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache }); stream.pipe(res); });
}
const decode = (v) => { try { return decodeURIComponent(v); } catch (e) { return ''; } };
const imageType = (f) => (/\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg');

const POST_ROUTES = {
  '/api/cameras/save': [saveCamera, false],
  '/api/cameras/delete': [deleteCamera, false],
  '/api/cameras/test': [testCamera, false],
  '/api/settings': [saveSettings, false],
  '/api/whatsapp/start': [whatsappStart, false],
  '/api/gate/config': [saveGateConfig, true],
  '/api/gate/cmd': [gateCommand, true],
  '/api/people': [savePerson, false],
  '/api/people/delete-photo': [deletePhoto, false],
  '/api/people/delete': [deletePerson, false],
  '/api/candidates/approve': [approveCandidates, false],
  '/api/candidates/discard': [discardCandidates, false],
  ...Object.fromEntries(Object.entries(CARS_POST).map(([p, fn]) => [p, [fn, true]])),
};

const server = http.createServer((req, res) => {
  if (!authorized(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  const camId = url.searchParams.get('camera') || '';

  if (req.method === 'POST') {
    if (pathname === '/api/people/upload') { handleUpload(req, res); return; }
    const route = POST_ROUTES[pathname];
    if (route) { handlePost(req, res, route[0], route[1]); return; }
  }

  if (pathname === '/stream' || pathname === '/snapshot') {
    let cam;
    try { cam = registry.resolve(camId); } catch (e) { res.writeHead(404); res.end(e.message); return; }
    if (pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-cache, no-store', Connection: 'close' });
      live.hub(cam, 'hd').addClient(res);
    } else {
      live.hub(cam, 'grid').snapshot().then((jpeg) => {
        if (!jpeg) { res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('sem sinal'); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        res.end(jpeg);
      });
    }
    return;
  }

  if (pathname === '/api/cameras') return handleGet(res, listCameras);
  if (pathname === '/api/settings') return handleGet(res, getSettings);
  if (pathname === '/api/whatsapp') return handleGet(res, whatsappStatus);
  if (pathname === '/api/whatsapp/qr') {
    waha(`api/${wahaSession()}/auth/qr?format=image`, 'image/png').then((r) => {
      if (r.status === 200 && /^image\//.test(r.type)) { res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'no-store' }); res.end(r.body); }
      else fail(res, 409, 'QR code indisponível: a sessão do WhatsApp não está aguardando leitura (já conectada ou parada)');
    }).catch((e) => fail(res, 502, e.message));
    return;
  }

  // gravações: ?camera=<id> ou ?camera=all (todas)
  if (pathname === '/api/days' || pathname === '/api/events') {
    const camsFor = () => (camId === 'all' || !camId ? registry.list() : [registry.resolve(camId)]);
    if (pathname === '/api/days') return handleGet(res, () => listDays(camsFor()));
    const date = url.searchParams.get('date') || '';
    if (!DATE_RE.test(date)) { res.writeHead(400); res.end('data inválida'); return; }
    return handleGet(res, () => listEvents(camsFor(), date));
  }
  const media = pathname.match(/^\/media\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (media) {
    const [cam, date, file] = [media[1], media[2], decode(media[3])];
    if (!CAM_ID_RE.test(cam) || !DATE_RE.test(date) || !FILE_RE.test(file)) { res.writeHead(400); res.end(); return; }
    sendFile(res, path.join(dataDir, cam, date, file), 'image/jpeg', 'public, max-age=86400');
    return;
  }

  // carros e garagem (por câmera)
  if (pathname === '/api/cars') return handleGet(res, () => listCars(registry.resolve(camId)));
  const car = pathname.match(/^\/car\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (car) {
    const file = decode(car[3]);
    if (!CAM_ID_RE.test(car[1]) || !(CAR_SLUG_RE.test(car[2]) || car[2] === '_capturas') || !safeImage(file)) { res.writeHead(400); res.end(); return; }
    sendFile(res, path.join(carsDir, car[1], car[2], file), imageType(file), 'no-cache');
    return;
  }

  // pessoas e rostos (valem para todas as câmeras)
  if (pathname === '/api/people') return handleGet(res, listPeople);
  const face = pathname.match(/^\/face\/([^/]+)\/([^/]+)$/);
  if (face) {
    const file = decode(face[2]);
    if (!SLUG_RE.test(face[1]) || !safeImage(file)) { res.writeHead(400); res.end(); return; }
    sendFile(res, path.join(facesDir, face[1], file), imageType(file), 'no-cache');
    return;
  }
  if (pathname === '/api/candidates') return handleGet(res, listCandidates);
  const cand = pathname.match(/^\/cand\/([^/]+)\/([^/]+)$/);
  if (cand) {
    const [folder, file] = [cand[1], decode(cand[2])];
    if (!CAND_FOLDER_RE.test(folder) || !CAND_FILE_RE.test(file)) { res.writeHead(400); res.end(); return; }
    sendFile(res, path.join(candDir, folder, file), /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', 'no-cache');
    return;
  }

  if (pathname === '/api/disk') {
    const retentionDays = config.retentionDays ?? 30;
    try {
      const st = fs.statfsSync(dataDir);
      sendJson(res, { free: st.bavail * st.bsize, total: st.blocks * st.bsize, retentionDays });
    } catch (e) { sendJson(res, { free: null, total: null, retentionDays }); }
    return;
  }

  // portão (por câmera)
  if (pathname === '/api/gate') return handleGet(res, () => { const cam = registry.resolve(camId); return { config: readGateFile(cam, 'gate.json') || {}, state: readGateFile(cam, 'state.json') }; });
  if (pathname === '/gate/latest.jpg') {
    let cam;
    try { cam = registry.resolve(camId); } catch (e) { res.writeHead(404); res.end('Not found'); return; }
    sendFile(res, path.join(gateDirOf(cam), 'latest.jpg'), 'image/jpeg', 'no-store');
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

if (!(config.auth && config.auth.passwordHash)) console.warn('AVISO: o painel está SEM senha. Rode ./set-password.sh para proteger.');
if (!registry.list().length) console.warn('Nenhuma câmera cadastrada: abra o painel e adicione na aba Câmeras.');
server.listen(port, '0.0.0.0', () => {
  console.log(`Painel disponível em:`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${port}`);
});
