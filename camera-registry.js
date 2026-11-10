// Cadastro de câmeras do painel: cameras/cameras.json (câmeras, com a senha de cada uma) e cameras/settings.json (ajustes
// globais, como o telefone que recebe os alertas). O painel escreve; o analyzer só lê.
// Sem dependências npm.

const fs = require('fs');
const path = require('path');

const CAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DAY_LIKE_RE = /^\d{2}-\d{2}-\d{4}$/;           // o id vira nome de pasta ao lado de dd-mm-yyyy: nunca pode parecer uma data
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const MAX_CAMERAS = 32;

const slugify = (v) => String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Endereços RTSP de cada marca: `live` é o stream leve (ao vivo no painel), `main` o de alta resolução (análise: rostos precisam dele).
const pad2 = (n) => String(n).padStart(2, '0');
const BRANDS = {
  intelbras: { label: 'Intelbras / Dahua', live: (ch) => `/cam/realmonitor?channel=${ch}&subtype=1`, main: (ch) => `/cam/realmonitor?channel=${ch}&subtype=0` },
  hikvision: { label: 'Hikvision', live: (ch) => `/Streaming/Channels/${ch}02`, main: (ch) => `/Streaming/Channels/${ch}01` },
  tapo: { label: 'TP-Link Tapo', live: () => '/stream2', main: () => '/stream1' },
  reolink: { label: 'Reolink', live: (ch) => `/h264Preview_${pad2(ch)}_sub`, main: (ch) => `/h264Preview_${pad2(ch)}_main` },
  custom: { label: 'Outra marca (endereço RTSP completo)' },
};

const enc = encodeURIComponent;
function buildUrls(c) {
  if (c.brand === 'custom') {
    const live = c.rtspUrl;
    return { rtspUrl: live, analyzerRtspUrl: c.analyzerRtspUrl || live.replace('subtype=1', 'subtype=0') };
  }
  const b = BRANDS[c.brand];
  const auth = c.user ? `${enc(c.user)}${c.password ? ':' + enc(c.password) : ''}@` : '';
  const base = `rtsp://${auth}${c.ip}:${c.port}`;
  return { rtspUrl: base + b.live(c.channel), analyzerRtspUrl: base + b.main(c.channel) };
}

// rtsp://user:SENHA@host/... -> rtsp://user:***@host/... (nunca mandamos a senha de volta para o navegador)
const maskUrl = (u) => String(u || '').replace(/^(rtsps?:\/\/[^:@/]*:)[^@]*@/, '$1***@');

function publicCamera(c) {
  return {
    id: c.id, nome: c.nome, brand: c.brand, ip: c.ip || '', port: c.port || 554, user: c.user || '', hasPassword: !!c.password,
    channel: c.channel || 1, enabled: c.enabled !== false, analyze: c.analyze !== false,
    rtspUrl: c.brand === 'custom' ? maskUrl(c.rtspUrl) : '', analyzerRtspUrl: c.brand === 'custom' ? maskUrl(c.analyzerRtspUrl) : '',
  };
}

const intIn = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} inválido (${min} a ${max})`);
  return n;
};
const noControl = (s) => !/[\u0000-\u001f\u007f]/.test(s);

// Valida o que veio da página e devolve a câmera completa, com os endereços RTSP calculados. `old` = cadastro atual (edição).
// Senha vazia na edição = mantém a atual. Endereço RTSP com "***" (como a página o recebeu) = mantém o atual.
function normalizeInput(input, old) {
  const nome = String(input.nome || '').trim();
  if (!nome) throw new Error('Informe o apelido da câmera.');
  if (nome.length > 60 || !noControl(nome)) throw new Error('Apelido inválido (até 60 caracteres).');
  const brand = String(input.brand || (old && old.brand) || 'intelbras');
  if (!BRANDS[brand]) throw new Error('Marca inválida.');
  const cam = { ...(old || {}), nome, brand,
    enabled: input.enabled === undefined ? (old ? old.enabled !== false : true) : !!input.enabled,
    analyze: input.analyze === undefined ? (old ? old.analyze !== false : true) : !!input.analyze };
  if (brand === 'custom') {
    const keep = (v, current) => (typeof v === 'string' && v.includes('***') && current ? current : v);
    const live = String(keep(input.rtspUrl, old && old.rtspUrl) || '').trim();
    if (!/^rtsps?:\/\/\S+$/.test(live) || live.length > 600 || !noControl(live)) throw new Error('Endereço RTSP inválido: ele começa com rtsp:// (ex.: rtsp://usuario:senha@192.168.0.10:554/caminho).');
    cam.rtspUrl = live;
    const main = String(keep(input.analyzerRtspUrl, old && old.analyzerRtspUrl) || '').trim();
    if (main && (!/^rtsps?:\/\/\S+$/.test(main) || main.length > 600 || !noControl(main))) throw new Error('Endereço RTSP de análise inválido.');
    cam.analyzerRtspUrl = main || undefined;
    for (const k of ['ip', 'port', 'user', 'password', 'channel']) delete cam[k];
  } else {
    const ip = String(input.ip || '').trim();
    if (!HOST_RE.test(ip)) throw new Error('IP inválido (ex.: 192.168.0.10).');
    cam.ip = ip;
    cam.port = input.port === undefined || input.port === '' ? (old && old.port) || 554 : intIn(input.port, 1, 65535, 'Porta');
    cam.channel = input.channel === undefined || input.channel === '' ? (old && old.channel) || 1 : intIn(input.channel, 1, 64, 'Canal');
    cam.user = String(input.user === undefined ? (old && old.user) || '' : input.user).trim();
    if (cam.user.length > 64 || !noControl(cam.user)) throw new Error('Usuário inválido.');
    const pw = input.password === undefined || input.password === '' ? (old && old.password) || '' : String(input.password);
    if (pw.length > 128 || !noControl(pw)) throw new Error('Senha inválida.');
    cam.password = pw;
    delete cam.rtspUrl; delete cam.analyzerRtspUrl;
  }
  Object.assign(cam, buildUrls(cam));
  if (cam.analyzerRtspUrl === undefined) delete cam.analyzerRtspUrl;
  return cam;
}

class Registry {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'cameras.json');
    this.settingsFile = path.join(dir, 'settings.json');
    this.cache = { sig: null, cameras: [] };
  }

  _writeFile(file, data) {
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      throw new Error(`não foi possível gravar ${path.basename(file)} (${e.code || e.message}): confira se a pasta cameras/ existe e pertence ao usuário do contêiner (rode ./setup.sh)`);
    }
  }

  list() {
    let st;
    try { st = fs.statSync(this.file); } catch (e) { this.cache = { sig: null, cameras: [] }; return []; }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (sig !== this.cache.sig) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.cache = { sig, cameras: (data.cameras || []).filter((c) => c && CAM_ID_RE.test(c.id)) };
      } catch (e) { console.error('cameras.json ilegível:', e.message); /* mantém a lista anterior */ }
    }
    return this.cache.cameras;
  }

  get(id) { return this.list().find((c) => c.id === id) || null; }

  // Câmera pedida pela página (?camera=id). Sem id, a primeira. Id desconhecido => erro (a página recarrega a lista).
  resolve(id) {
    const cam = id ? this.get(id) : this.list()[0];
    if (!cam) throw Object.assign(new Error(id ? 'câmera não encontrada' : 'nenhuma câmera cadastrada'), { code: 'NO_CAMERA' });
    return cam;
  }

  _uniqueId(nome, cameras) {
    let base = slugify(nome) || 'camera';
    if (DAY_LIKE_RE.test(base)) base = 'cam-' + base;
    let id = base, n = 1;
    while (cameras.some((c) => c.id === id)) { n++; id = base.slice(0, 40 - String(n).length - 1) + '-' + n; }
    return id;
  }

  save(input) {
    const cameras = this.list().map((c) => ({ ...c }));
    const old = input.id ? cameras.find((c) => c.id === input.id) : null;
    if (input.id && !old) throw new Error('câmera não encontrada');
    const cam = normalizeInput(input, old);
    if (old) cameras[cameras.indexOf(old)] = cam;
    else {
      if (cameras.length >= MAX_CAMERAS) throw new Error(`limite de ${MAX_CAMERAS} câmeras`);
      cam.id = this._uniqueId(cam.nome, cameras);
      cameras.push(cam);
    }
    this._writeFile(this.file, { cameras });
    this.cache.sig = null;
    return cam;
  }

  remove(id) {
    const cameras = this.list();
    if (!cameras.some((c) => c.id === id)) throw new Error('câmera não encontrada');
    this._writeFile(this.file, { cameras: cameras.filter((c) => c.id !== id) });
    this.cache.sig = null;
  }

  settings() {
    try { return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch (e) { return {}; }
  }

  saveSettings(patch) {
    const s = { ...this.settings(), ...patch };
    for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
    this._writeFile(this.settingsFile, s);
    return s;
  }
}

// ---- Instalação antiga (uma câmera só, no config.json) ----
// Cria cameras.json com a câmera do config.json na primeira subida depois da atualização. O analyzer move as pastas antigas
// (fotos, portão, garagem) para as pastas dessa câmera, que fica marcada com legacy: true.
const LEGACY_URL_RE = /^rtsp:\/\/([^:@/]*):([^@]*)@([^:/]+)(?::(\d+))?\/cam\/realmonitor\?channel=(\d+)&subtype=\d+$/;
const tryDecode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };

function migrateFromConfig(registry, config, gateDir, log = console.log) {
  if (fs.existsSync(registry.file) || !config.rtspUrl) return false;
  // o telefone escolhido na página ficava em gate/gate.json: agora vale para todas as câmeras (settings.json)
  try {
    const g = JSON.parse(fs.readFileSync(path.join(gateDir, 'gate.json'), 'utf8'));
    const carry = {};
    if (g.phone) carry.phone = g.phone;
    if (g.whatsappDownMin) carry.whatsappDownMin = g.whatsappDownMin;
    if (Object.keys(carry).length && !Object.keys(registry.settings()).length) registry.saveSettings(carry);
  } catch (e) { /* sem gate.json: nada a levar */ }
  const m = LEGACY_URL_RE.exec(config.rtspUrl);
  const cam = { id: 'camera-1', nome: 'Câmera 1', enabled: true, analyze: true, legacy: true };
  if (m && !config.analyzerRtspUrl) {
    Object.assign(cam, { brand: 'intelbras', ip: m[3], port: Number(m[4] || 554), user: tryDecode(m[1]), password: tryDecode(m[2]), channel: Number(m[5]) });
    Object.assign(cam, buildUrls(cam));
  } else {
    Object.assign(cam, { brand: 'custom', rtspUrl: config.rtspUrl, analyzerRtspUrl: config.analyzerRtspUrl || config.rtspUrl.replace('subtype=1', 'subtype=0') });
  }
  registry._writeFile(registry.file, { cameras: [cam] });
  log('config.json tinha uma câmera só: cadastrada como "Câmera 1" em cameras/cameras.json (renomeie na aba Câmeras)');
  return true;
}

module.exports = { Registry, BRANDS, CAM_ID_RE, slugify, buildUrls, maskUrl, publicCamera, normalizeInput, migrateFromConfig };
