// Ao vivo: converte o RTSP de cada câmera em MJPEG com o ffmpeg. Sem dependências npm; só precisa do ffmpeg.
//
// Cada (câmera, perfil) tem um "hub": um ffmpeg que só roda enquanto alguém assiste.
//   perfil "hd"   -> visão de uma câmera: MJPEG contínuo (multipart), com buffer anti-travamento.
//   perfil "grid" -> visão em grade: quadros menores e mais lentos, entregues um a um (/snapshot). Não prende uma conexão
//                    aberta por câmera (o navegador só abre ~6 por site), então a grade aguenta qualquer número de câmeras.

const { spawn } = require('child_process');

const FRAME_START = Buffer.from('--frame\r\n');
const redact = (t) => String(t).replace(/rtsps?:\/\/[^@\s]*@/g, 'rtsp://***@');

// Separa a saída "mpjpeg" do ffmpeg em quadros completos: onFrame({ raw: cabeçalho + JPEG, jpeg }).
class FrameParser {
  constructor(onFrame) { this.onFrame = onFrame; this.pending = Buffer.alloc(0); }

  reset() { this.pending = Buffer.alloc(0); }

  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const start = this.pending.indexOf(FRAME_START);
      if (start < 0) { this.pending = this.pending.subarray(Math.max(0, this.pending.length - FRAME_START.length)); return; }
      if (start > 0) this.pending = this.pending.subarray(start);
      const headerEnd = this.pending.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(this.pending.toString('latin1', 0, headerEnd));
      if (!m) { this.pending = this.pending.subarray(FRAME_START.length); continue; }
      const bodyStart = headerEnd + 4, bodyEnd = bodyStart + Number(m[1]);
      const next = this.pending.indexOf(FRAME_START, bodyEnd);
      if (next < 0) return; // o quadro só está completo quando o próximo começa
      this.onFrame({ raw: Buffer.from(this.pending.subarray(0, next)), jpeg: Buffer.from(this.pending.subarray(bodyStart, bodyEnd)) });
      this.pending = this.pending.subarray(next);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Hub {
  constructor(cam, profile, ffmpegBin) {
    this.id = cam.id;
    this.url = cam.rtspUrl;
    this.profile = profile;
    this.ffmpegBin = ffmpegBin;
    this.tag = `[${cam.id}/${profile.name}]`;
    this.clients = new Set();
    this.ffmpeg = null;
    this.latest = null;        // último JPEG
    this.latestAt = 0;
    this.lastSnapshotAt = 0;   // alguém pediu um quadro há pouco => segue ligado
    this.idleSince = 0;
    this.watch = null;
    this.destroyed = false;
    this.parser = new FrameParser((f) => this.onFrame(f));
    // Buffer anti-travamento: a rede até a câmera tem soluços (0,5 a 2 s parado, depois uma rajada). Guardamos alguns segundos
    // de quadros e os entregamos em ritmo constante; custo: o ao vivo fica atrasado por esse tempo.
    this.queue = []; this.playing = false; this.starved = false; this.pacer = null;
  }

  get active() { return this.clients.size > 0 || Date.now() - this.lastSnapshotAt < 10000; }

  addClient(res) {
    this.clients.add(res);
    this.ensure();
    res.on('close', () => this.clients.delete(res));
  }

  async snapshot() {
    this.lastSnapshotAt = Date.now();
    this.ensure();
    for (let i = 0; i < 40 && !this.latest; i++) await sleep(200); // primeiro quadro: o ffmpeg ainda está conectando
    return this.latest && Date.now() - this.latestAt < 15000 ? this.latest : null;
  }

  ensure() {
    if (this.destroyed || this.ffmpeg) return;
    this.start();
  }

  start() {
    const p = this.profile;
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-timeout', '8000000', // 8 s sem dados => ffmpeg sai e o painel reconecta (antes podia ficar parado sem aviso)
      '-i', this.url,
      '-an',
      '-vf', `fps=${p.fps},scale='min(${p.width},iw)':-2`,
      '-q:v', String(p.quality),
      '-f', 'mpjpeg', '-boundary_tag', 'frame',
      'pipe:1',
    ];
    const ff = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ff;
    console.log(this.tag, 'ffmpeg iniciado');
    this.parser.reset();
    this.latest = null;    // o snapshot espera um quadro novo, em vez de entregar um velho
    this.idleSince = 0;
    if (p.delay > 0) this.startPacer();
    ff.stdout.on('data', (chunk) => this.parser.push(chunk));
    ff.stderr.on('data', (d) => process.stderr.write(`${this.tag} ${redact(d.toString())}`));
    ff.on('error', (e) => {
      console.error(this.tag, 'falha ao executar o ffmpeg:', e.message);
      if (this.ffmpeg !== ff) return;
      this.ffmpeg = null;
      this.stopPacer();
      for (const res of this.clients) res.end();
      this.clients.clear();
    });
    ff.on('close', (code) => {
      console.log(this.tag, 'ffmpeg encerrou, código', code);
      if (this.ffmpeg !== ff) return;   // foi parado de propósito (ou já há outro no lugar)
      this.ffmpeg = null;
      this.stopPacer();
      if (!this.destroyed && this.active) setTimeout(() => this.ensure(), 1500); // ainda há quem assista (queda da câmera): reconecta
    });
    clearInterval(this.watch);
    this.watch = setInterval(() => this.checkIdle(), 2000);
  }

  checkIdle() {
    if (this.active) { this.idleSince = 0; return; }
    this.idleSince = this.idleSince || Date.now();
    if (Date.now() - this.idleSince >= 5000) {
      this.stop();
      console.log(this.tag, 'sem espectadores, ffmpeg parado');
    }
  }

  onFrame({ raw, jpeg }) {
    this.latest = jpeg;
    this.latestAt = Date.now();
    if (this.profile.delay > 0) this.queue.push(raw);
    else for (const res of this.clients) res.write(raw);
  }

  startPacer() {
    const p = this.profile;
    clearInterval(this.pacer);
    this.queue = []; this.playing = false; this.starved = false;
    const target = Math.max(1, Math.round(p.delay * p.fps));  // quadros guardados em condições normais
    const resumeAt = Math.max(1, Math.floor(target / 2));      // após esvaziar, volta a tocar com metade
    this.pacer = setInterval(() => {
      if (!this.playing) { if (this.queue.length >= (this.starved ? resumeAt : target)) this.playing = true; else return; }
      while (this.queue.length > target * 2 + 2) this.queue.shift();   // chegou rajada: descarta os mais antigos
      const frame = this.queue.shift();
      if (frame) { for (const res of this.clients) res.write(frame); }
      else { this.playing = false; this.starved = true; }              // esvaziou (parada longa)
    }, 1000 / p.fps);
  }

  stopPacer() { clearInterval(this.pacer); this.pacer = null; }

  stop() {
    clearInterval(this.watch);
    this.stopPacer();
    const ff = this.ffmpeg;
    this.ffmpeg = null;
    if (ff) ff.kill();
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

class Live {
  constructor({ ffmpegBin, config }) {
    this.ffmpegBin = ffmpegBin;
    this.hubs = new Map();
    const liveDelay = Number.isFinite(config.liveDelaySec) ? config.liveDelaySec : 2;  // "liveDelaySec" no config.json (0 desliga)
    this.profiles = {
      hd: { name: 'hd', width: config.width || 1280, fps: config.fps || 10, quality: config.quality || 5, delay: liveDelay },
      grid: { name: 'grid', width: config.gridWidth || 640, fps: config.gridFps || 5, quality: config.gridQuality || 8, delay: 0 },
    };
  }

  hub(cam, profileName) {
    const key = `${cam.id}/${profileName}`;
    let h = this.hubs.get(key);
    if (h && h.url !== cam.rtspUrl) { h.destroy(); h = null; }   // endereço da câmera mudou no painel
    if (!h) { h = new Hub(cam, this.profiles[profileName], this.ffmpegBin); this.hubs.set(key, h); }
    return h;
  }

  forget(camId) {
    for (const [key, h] of this.hubs) if (h.id === camId) { h.destroy(); this.hubs.delete(key); }
  }
}

// Testa uma câmera: conecta, pega UM quadro e devolve { ok, ms, jpeg } ou { ok: false, error } com a causa em português.
function probe(ffmpegBin, url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = []; let err = '', done = false;
    const ff = spawn(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '8000000', '-i', url,
      '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); ff.kill(); resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, error: explain('timed out') }), timeoutMs);
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', (e) => finish({ ok: false, error: `Não foi possível executar o ffmpeg: ${e.message}` }));
    ff.on('close', () => {
      const jpeg = Buffer.concat(chunks);
      if (jpeg.length > 100 && jpeg[0] === 0xff && jpeg[1] === 0xd8) finish({ ok: true, ms: Date.now() - t0, jpeg });
      else finish({ ok: false, error: explain(err) });
    });
  });
}

function explain(stderr) {
  const t = redact(stderr).toLowerCase();
  if (/401|unauthorized/.test(t)) return 'A câmera recusou o acesso: usuário ou senha incorretos.';
  if (/404|not found/.test(t)) return 'A câmera respondeu, mas não achou esse caminho ou canal: confira a marca e o número do canal.';
  if (/connection refused/.test(t)) return 'A câmera recusou a conexão: confira o IP e a porta (normalmente 554).';
  if (/timed out|timeout|no route|unreachable|network is down|name or service not known/.test(t)) return 'Não foi possível alcançar a câmera: confira o IP, se ela está ligada e se está na mesma rede deste computador.';
  const line = redact(stderr).trim().split('\n').pop();
  return line ? `Falha ao conectar: ${line.slice(0, 160)}` : 'Não foi possível obter imagem da câmera.';
}

module.exports = { Live, FrameParser, probe, explain, redact };
