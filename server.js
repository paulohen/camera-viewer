// Visualizador simples de câmera IP (RTSP) na rede local.
// Converte o RTSP em MJPEG via ffmpeg e serve uma página que o exibe.
// Sem dependências npm; requer apenas o ffmpeg no PATH (ou FFMPEG_PATH).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json não encontrado. Copie config.example.json para config.json e preencha.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const port = config.port || 8090;
const dataDir = process.env.DATA_DIR || config.dataDir || '/data'; // fotos salvas pelo analyzer: dd-mm-yyyy/HH-MM-SS_rotulo.jpg
const candDir = process.env.CANDIDATES_DIR || '/candidates'; // faces_candidates/ do analyzer (revisão)
const carsDir = process.env.CARS_DIR || '/cars';              // carros cadastrados, zona da garagem e capturas (compartilhado com o analyzer)
const facesDir = process.env.FACES_DIR || '/faces';          // faces/: rostos usados no reconhecimento
const gateDir = process.env.GATE_DIR || '/gate';              // calibração/estado do monitor do portão (compartilhado com o analyzer)
const ffmpegBin = process.env.FFMPEG_PATH || config.ffmpegPath || 'ffmpeg';

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

const clients = new Set();
let ffmpeg = null;

// ---- Buffer anti-travamento do ao vivo ----
// A rede até a câmera tem soluços: o vídeo para por 0,5 a 2 s e depois chega em rajada. Guardamos alguns segundos de
// quadros e os entregamos em ritmo constante; paradas menores que o buffer não aparecem. Custo: o ao vivo fica atrasado
// por esse tempo. Configure com "liveDelaySec" no config.json (padrão 2; 0 desliga e entrega direto).
const liveDelay = Number.isFinite(config.liveDelaySec) ? config.liveDelaySec : 2;
const liveFps = config.fps || 10;
const FRAME_START = Buffer.from('--frame\r\n');
let pending = Buffer.alloc(0); // bytes que ainda não formam um quadro completo
let queue = [];                // quadros completos (cabeçalho + JPEG), aguardando a vez
let playing = false;
let starved = false;           // a fila esvaziou: recomeça a tocar com metade do alvo
let pacer = null;

function parseFrames(chunk) {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const start = pending.indexOf(FRAME_START);
    if (start < 0) { pending = pending.subarray(Math.max(0, pending.length - FRAME_START.length)); return; }
    if (start > 0) pending = pending.subarray(start);
    const headerEnd = pending.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const m = /content-length:\s*(\d+)/i.exec(pending.toString('latin1', 0, headerEnd));
    if (!m) { pending = pending.subarray(FRAME_START.length); continue; }
    const next = pending.indexOf(FRAME_START, headerEnd + 4 + Number(m[1]));
    if (next < 0) return; // o quadro só está completo quando o próximo começa
    queue.push(Buffer.from(pending.subarray(0, next)));
    pending = pending.subarray(next);
  }
}

function startPacer() {
  clearInterval(pacer);
  queue = []; pending = Buffer.alloc(0); playing = false; starved = false;
  const target = Math.max(1, Math.round(liveDelay * liveFps));  // quadros guardados em condições normais
  const resumeAt = Math.max(1, Math.floor(target / 2));          // após esvaziar, volta a tocar com metade
  pacer = setInterval(() => {
    if (!playing) { if (queue.length >= (starved ? resumeAt : target)) playing = true; else return; }
    while (queue.length > target * 2 + 2) queue.shift();          // chegou rajada: descarta os mais antigos
    const frame = queue.shift();
    if (frame) { for (const res of clients) res.write(frame); }
    else { playing = false; starved = true; }               // esvaziou (parada longa)
  }, 1000 / liveFps);
}
let stopTimer = null;

function startFfmpeg() {
  if (ffmpeg) return;
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-timeout', '8000000', // 8 s sem dados => ffmpeg sai e o painel reconecta (antes podia ficar parado sem aviso)
    '-i', config.rtspUrl,
    '-an',
    '-vf', `fps=${config.fps || 10},scale='min(${config.width || 1280},iw)':-2`,
    '-q:v', String(config.quality || 5),
    '-f', 'mpjpeg', '-boundary_tag', 'frame',
    'pipe:1',
  ];
  ffmpeg = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('ffmpeg iniciado');

  if (liveDelay > 0) startPacer();
  ffmpeg.stdout.on('data', (chunk) => {
    if (liveDelay > 0) parseFrames(chunk);
    else for (const res of clients) res.write(chunk);
  });
  ffmpeg.stderr.on('data', (d) => process.stderr.write(d.toString().replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@')));
  ffmpeg.on('error', (e) => {
    console.error('Falha ao executar o ffmpeg:', e.message);
    ffmpeg = null;
    for (const res of clients) res.end();
    clients.clear();
  });
  ffmpeg.on('close', (code) => {
    console.log('ffmpeg encerrou, código', code);
    ffmpeg = null;
    // Se ainda há espectadores (queda da câmera), tenta reconectar.
    if (clients.size > 0) setTimeout(startFfmpeg, 1500);
    else clearInterval(pacer);
  });
}

function stopFfmpegSoon() {
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    if (clients.size === 0 && ffmpeg) {
      ffmpeg.kill();
      ffmpeg = null;
      console.log('Sem espectadores, ffmpeg parado');
    }
  }, 5000);
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

async function listDays() {
  const days = [];
  for (const d of await fs.promises.readdir(dataDir).catch(() => [])) {
    if (!DATE_RE.test(d)) continue;
    const files = await fs.promises.readdir(path.join(dataDir, d)).catch(() => []);
    days.push({ date: d, count: files.filter((f) => FILE_RE.test(f)).length });
  }
  return days.filter((d) => d.count > 0).sort((a, b) => dateKey(b.date).localeCompare(dateKey(a.date)));
}

async function listEvents(date) {
  const files = (await fs.promises.readdir(path.join(dataDir, date)).catch(() => [])).filter((f) => FILE_RE.test(f));
  const events = await Promise.all(files.map(async (file) => {
    const ev = { file, time: file.slice(0, 8).replace(/-/g, ':'), tags: tagsOf(file) };
    try {
      const j = JSON.parse(await fs.promises.readFile(path.join(dataDir, date, file.replace(/\.jpg$/, '.json')), 'utf8'));
      if (j.segundos_em_cena !== undefined) ev.seconds = j.segundos_em_cena;
      const face = (j.detections || []).find((d) => d.face);
      if (face) ev.faceConf = face.conf;
      if (j.evento) ev.evento = j.evento;   // eventos da garagem: parou | saiu
    } catch (e) { /* sem JSON: mostra só o que está no nome do arquivo */ }
    return ev;
  }));
  return events.sort((a, b) => b.file.localeCompare(a.file));
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

function readGateFile(name) {
  try { return JSON.parse(fs.readFileSync(path.join(gateDir, name), 'utf8')); } catch (e) { return null; }
}
function writeGateFile(name, data) {
  const dst = path.join(gateDir, name);
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

function saveGateConfig(body) {
  const cfg = readGateFile('gate.json') || {};
  if (body.roi !== undefined) {
    if (body.roi === null) cfg.roi = null;
    else {
      const r = body.roi;
      const roi = { x: num(r.x, 0, 1), y: num(r.y, 0, 1), w: num(r.w, 0.01, 1), h: num(r.h, 0.01, 1) };
      if (roi.x + roi.w > 1.0001 || roi.y + roi.h > 1.0001) throw new Error('região fora da imagem');
      cfg.roi = roi;
    }
  }
  if (body.phone !== undefined) {
    if (body.phone === '') delete cfg.phone; // volta a usar o telefone do config.json
    else cfg.phone = normalizePhone(body.phone);
  }
  const time = (v) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error('horário inválido (use HH:MM)'); return v; };
  if (body.unknownEnabled !== undefined) cfg.unknownEnabled = !!body.unknownEnabled;
  if (body.unknownFrom !== undefined) cfg.unknownFrom = time(body.unknownFrom);
  if (body.unknownTo !== undefined) cfg.unknownTo = time(body.unknownTo);
  if (body.unknownCooldownMin !== undefined) cfg.unknownCooldownMin = num(body.unknownCooldownMin, 0, 1440);
  if (body.unknownIncludeNoFace !== undefined) cfg.unknownIncludeNoFace = !!body.unknownIncludeNoFace;
  if (body.healthEnabled !== undefined) cfg.healthEnabled = !!body.healthEnabled;
  if (body.cameraDownMin !== undefined) cfg.cameraDownMin = num(body.cameraDownMin, 1, 1440);
  if (body.whatsappDownMin !== undefined) cfg.whatsappDownMin = num(body.whatsappDownMin, 1, 1440);
  if (body.threshold !== undefined) cfg.threshold = num(body.threshold, 0.05, 0.99);
  if (body.alertAfterMin !== undefined) cfg.alertAfterMin = num(body.alertAfterMin, 0.5, 1440);
  if (body.repeatMin !== undefined) cfg.repeatMin = num(body.repeatMin, 0, 1440);
  if (body.notifyClosed !== undefined) cfg.notifyClosed = !!body.notifyClosed;
  if (body.enabled !== undefined) cfg.enabled = !!body.enabled;
  writeGateFile('gate.json', cfg);
  return cfg;
}

const GATE_CMDS = ['add_closed', 'clear_refs', 'calibrate_open', 'test_alert', 'test_telegram'];
function gateCommand(body) {
  if (!GATE_CMDS.includes(body.cmd)) throw new Error('comando inválido');
  if (fs.existsSync(path.join(gateDir, 'cmd.json'))) throw new Error('aguarde: o comando anterior ainda está sendo processado');
  writeGateFile('cmd.json', { cmd: body.cmd });
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
  const status = readGateFile('faces_status.json') || {};   // o analyzer diz se achou rosto em cada foto
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
const carsCfgPath = path.join(carsDir, 'cars.json');
const CARS_DEFAULT = { garage: null, stopSec: 20, threshold: 0.40, alertUnknown: false, cars: {} };
function readCarsCfg() { try { return { ...CARS_DEFAULT, ...JSON.parse(fs.readFileSync(carsCfgPath, 'utf8')) }; } catch (e) { return { ...CARS_DEFAULT, cars: {} }; } }
function writeCarsCfg(cfg) { fs.writeFileSync(carsCfgPath + '.tmp', JSON.stringify(cfg, null, 1)); fs.renameSync(carsCfgPath + '.tmp', carsCfgPath); }
const CAR_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;  // "_capturas" começa com "_": nunca confunde com um carro

async function listCars() {
  const cfg = readCarsCfg();
  const slugs = new Set(Object.keys(cfg.cars));
  for (const d of await fs.promises.readdir(carsDir, { withFileTypes: true }).catch(() => [])) if (d.isDirectory() && CAR_SLUG_RE.test(d.name)) slugs.add(d.name);
  const cars = [];
  for (const slug of [...slugs].sort()) {
    const photos = (await fs.promises.readdir(path.join(carsDir, slug)).catch(() => [])).filter(safeImage).sort();
    const o = cfg.cars[slug] || {};
    cars.push({ slug, nome: o.nome || slug, alertOnPark: !!o.alertOnPark, alertOnLeave: !!o.alertOnLeave, photos });
  }
  const captures = (await fs.promises.readdir(path.join(carsDir, '_capturas')).catch(() => [])).filter(safeImage).sort().reverse();
  const { cars: _omit, ...settings } = cfg;
  return { settings, cars, captures, state: readGateFile('cars_state.json') };
}

async function saveCarsConfig(body) {
  const cfg = readCarsCfg();
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
  await fs.promises.mkdir(carsDir, { recursive: true });
  writeCarsCfg(cfg);
  return cfg;
}

async function saveCar(body) {
  const cfg = readCarsCfg();
  const nome = String(body.nome || '').trim().slice(0, 60);
  const slug = body.slug || slugify(nome);
  if (!CAR_SLUG_RE.test(slug)) throw new Error('nome inválido: use letras e números');
  const exists = !!cfg.cars[slug] || fs.existsSync(path.join(carsDir, slug));
  if (body.slug && !exists) throw new Error('carro não encontrado');
  if (!exists && !nome) throw new Error('informe o nome do carro');
  await fs.promises.mkdir(path.join(carsDir, slug), { recursive: true });
  const old = cfg.cars[slug] || {};
  cfg.cars[slug] = {
    nome: nome || old.nome || slug,
    alertOnPark: body.alertOnPark !== undefined ? !!body.alertOnPark : (old.alertOnPark ?? true),   // carro novo: avisa ao parar
    alertOnLeave: body.alertOnLeave !== undefined ? !!body.alertOnLeave : !!old.alertOnLeave,
  };
  writeCarsCfg(cfg);
  return { slug, created: !exists };
}

async function deleteCar(body) {
  if (!CAR_SLUG_RE.test(body.slug || '')) throw new Error('carro inválido');
  const dir = path.join(carsDir, body.slug);
  for (const f of await fs.promises.readdir(dir).catch(() => [])) if (safeImage(f)) await fs.promises.unlink(path.join(dir, f));
  await fs.promises.rmdir(dir).catch(() => { /* já não existia */ });
  const cfg = readCarsCfg(); delete cfg.cars[body.slug]; writeCarsCfg(cfg);
  return { ok: true };
}

async function deleteCarPhoto(body) {
  if (!CAR_SLUG_RE.test(body.slug || '') || !safeImage(body.file)) throw new Error('foto inválida');
  await fs.promises.unlink(path.join(carsDir, body.slug, body.file));
  return { ok: true };
}

async function carsCapture() {
  if (fs.existsSync(path.join(carsDir, 'cmd.json'))) throw new Error('aguarde: o comando anterior ainda está sendo processado');
  await fs.promises.mkdir(path.join(carsDir, '_capturas'), { recursive: true });
  fs.writeFileSync(path.join(carsDir, 'cmd.json'), JSON.stringify({ cmd: 'capture' }));
  return { queued: true };
}

async function assignCapture(body) {
  if (!safeImage(body.file)) throw new Error('captura inválida');
  const src = path.join(carsDir, '_capturas', body.file);
  if (!fs.existsSync(src)) throw new Error('captura não encontrada');
  const slug = body.slug || slugify(body.nome || '');
  if (!CAR_SLUG_RE.test(slug)) throw new Error('escolha um carro ou informe um nome');
  const cfg = readCarsCfg();
  if (!cfg.cars[slug] && !fs.existsSync(path.join(carsDir, slug))) await saveCar({ nome: body.nome });
  await fs.promises.mkdir(path.join(carsDir, slug), { recursive: true });
  await fs.promises.rename(src, path.join(carsDir, slug, `${Date.now()}_${body.file}`));
  return { slug };
}

async function discardCapture(body) {
  if (!safeImage(body.file)) throw new Error('captura inválida');
  await fs.promises.unlink(path.join(carsDir, '_capturas', body.file));
  return { ok: true };
}

const CARS_POST = { '/api/cars/config': saveCarsConfig, '/api/cars/save': saveCar, '/api/cars/delete': deleteCar,
  '/api/cars/delete-photo': deleteCarPhoto, '/api/cars/capture': carsCapture, '/api/cars/assign': assignCapture, '/api/cars/discard': discardCapture };

const server = http.createServer((req, res) => {
  if (!authorized(req, res)) return;
  const pathname = req.url.split('?')[0];
  if (pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'close',
    });
    clients.add(res);
    clearTimeout(stopTimer);
    startFfmpeg();
    req.on('close', () => {
      clients.delete(res);
      if (clients.size === 0) stopFfmpegSoon();
    });
    return;
  }
  if (pathname === '/api/days') {
    listDays().then((d) => sendJson(res, d)).catch(() => { res.writeHead(500); res.end(); });
    return;
  }
  if (pathname === '/api/events') {
    const date = new URL(req.url, 'http://x').searchParams.get('date') || '';
    if (!DATE_RE.test(date)) { res.writeHead(400); res.end('data inválida'); return; }
    listEvents(date).then((e) => sendJson(res, e)).catch(() => { res.writeHead(500); res.end(); });
    return;
  }
  if (pathname === '/api/cars') { listCars().then((d) => sendJson(res, d)).catch(() => { res.writeHead(500); res.end(); }); return; }
  if (req.method === 'POST' && CARS_POST[pathname]) {
    if (!sameOriginJson(req)) { res.writeHead(403); res.end('forbidden'); return; }
    readJson(req).then(CARS_POST[pathname]).then((r) => sendJson(res, r)).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  const car = pathname.match(/^\/car\/([^/]+)\/([^/]+)$/);
  if (car) {
    let file = '';
    try { file = decodeURIComponent(car[2]); } catch (e) { /* inválido */ }
    if (!(CAR_SLUG_RE.test(car[1]) || car[1] === '_capturas') || !safeImage(file)) { res.writeHead(400); res.end(); return; }
    const stream = fs.createReadStream(path.join(carsDir, car[1], file));
    stream.on('error', () => { res.writeHead(404); res.end('Not found'); });
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache' });
      stream.pipe(res);
    });
    return;
  }
  if (pathname === '/api/people') {
    if (req.method === 'POST') {
      if (!sameOriginJson(req)) { res.writeHead(403); res.end('forbidden'); return; }
      readJson(req).then(savePerson).then((r) => sendJson(res, r)).catch((e) => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.message }));
      });
    } else listPeople().then((d) => sendJson(res, d)).catch(() => { res.writeHead(500); res.end(); });
    return;
  }
  if (req.method === 'POST' && (pathname === '/api/people/delete-photo' || pathname === '/api/people/delete')) {
    if (!sameOriginJson(req)) { res.writeHead(403); res.end('forbidden'); return; }
    readJson(req).then(pathname.endsWith('delete-photo') ? deletePhoto : deletePerson).then((r) => sendJson(res, r)).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/people/upload') { handleUpload(req, res); return; }
  const face = pathname.match(/^\/face\/([^/]+)\/([^/]+)$/);
  if (face) {
    let file = '';
    try { file = decodeURIComponent(face[2]); } catch (e) { /* inválido */ }
    if (!SLUG_RE.test(face[1]) || !safeImage(file)) { res.writeHead(400); res.end(); return; }
    const stream = fs.createReadStream(path.join(facesDir, face[1], file));
    stream.on('error', () => { res.writeHead(404); res.end('Not found'); });
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'no-cache' });
      stream.pipe(res);
    });
    return;
  }
  if (pathname === '/api/candidates') {
    listCandidates().then((d) => sendJson(res, d)).catch(() => { res.writeHead(500); res.end(); });
    return;
  }
  if (req.method === 'POST' && (pathname === '/api/candidates/approve' || pathname === '/api/candidates/discard')) {
    if (!sameOriginJson(req)) { res.writeHead(403); res.end('forbidden'); return; }
    const action = pathname.endsWith('approve') ? approveCandidates : discardCandidates;
    readJson(req).then(action).then((r) => sendJson(res, r)).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  const cand = pathname.match(/^\/cand\/([^/]+)\/([^/]+)$/);
  if (cand) {
    const [folder, file] = [cand[1], decodeURIComponent(cand[2])];
    if (!CAND_FOLDER_RE.test(folder) || !CAND_FILE_RE.test(file)) { res.writeHead(400); res.end(); return; }
    const stream = fs.createReadStream(path.join(candDir, folder, file));
    stream.on('error', () => { res.writeHead(404); res.end('Not found'); });
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache' });
      stream.pipe(res);
    });
    return;
  }
  if (pathname === '/api/disk') {
    try {
      const st = fs.statfsSync(dataDir);
      sendJson(res, { free: st.bavail * st.bsize, total: st.blocks * st.bsize, retentionDays: config.retentionDays ?? 30 });
    } catch (e) { sendJson(res, { free: null, total: null, retentionDays: config.retentionDays ?? 30 }); }
    return;
  }
  if (pathname === '/api/gate') {
    sendJson(res, { config: readGateFile('gate.json') || {}, state: readGateFile('state.json') });
    return;
  }
  if (req.method === 'POST' && (pathname === '/api/gate/config' || pathname === '/api/gate/cmd')) {
    if (!sameOriginJson(req)) { res.writeHead(403); res.end('forbidden'); return; }
    const action = pathname.endsWith('config') ? saveGateConfig : gateCommand;
    readJson(req).then(action).then((r) => sendJson(res, r)).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (pathname === '/gate/latest.jpg') {
    const stream = fs.createReadStream(path.join(gateDir, 'latest.jpg'));
    stream.on('error', () => { res.writeHead(404); res.end('Not found'); });
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      stream.pipe(res);
    });
    return;
  }
  const media = pathname.match(/^\/media\/([^/]+)\/([^/]+)$/);
  if (media) {
    const [date, file] = [media[1], decodeURIComponent(media[2])];
    if (!DATE_RE.test(date) || !FILE_RE.test(file)) { res.writeHead(400); res.end(); return; }
    const stream = fs.createReadStream(path.join(dataDir, date, file));
    stream.on('error', () => { res.writeHead(404); res.end('Not found'); });
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      stream.pipe(res);
    });
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
server.listen(port, '0.0.0.0', () => {
  console.log(`Câmera disponível em:`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${port}`);
});
