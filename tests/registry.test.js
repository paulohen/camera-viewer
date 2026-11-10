// node --test tests/    (sem dependências; não precisa de ffmpeg nem de câmera)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Registry, buildUrls, maskUrl, publicCamera, normalizeInput, migrateFromConfig } = require('../camera-registry');
const { FrameParser, explain, redact } = require('../live');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'camreg-'));
const form = (o = {}) => ({ nome: 'Garagem', brand: 'intelbras', ip: '192.168.0.10', user: 'admin', password: 'p@ss:w/rd', ...o });

test('buildUrls: Intelbras/Dahua usa sub-stream no ao vivo e o principal na análise, com a senha codificada', () => {
  const u = buildUrls({ brand: 'intelbras', ip: '192.168.0.10', port: 554, user: 'admin', password: 'p@ss:w/rd', channel: 2 });
  assert.strictEqual(u.rtspUrl, 'rtsp://admin:p%40ss%3Aw%2Frd@192.168.0.10:554/cam/realmonitor?channel=2&subtype=1');
  assert.strictEqual(u.analyzerRtspUrl, 'rtsp://admin:p%40ss%3Aw%2Frd@192.168.0.10:554/cam/realmonitor?channel=2&subtype=0');
});

test('buildUrls: outras marcas e câmera sem senha', () => {
  assert.match(buildUrls({ brand: 'hikvision', ip: '10.0.0.5', port: 554, user: 'u', password: 'x', channel: 1 }).analyzerRtspUrl, /\/Streaming\/Channels\/101$/);
  assert.match(buildUrls({ brand: 'tapo', ip: '10.0.0.5', port: 554, user: 'u', password: 'x', channel: 1 }).rtspUrl, /\/stream2$/);
  assert.match(buildUrls({ brand: 'reolink', ip: '10.0.0.5', port: 554, user: 'u', password: 'x', channel: 1 }).analyzerRtspUrl, /h264Preview_01_main$/);
  assert.strictEqual(buildUrls({ brand: 'tapo', ip: '10.0.0.5', port: 8554, user: '', password: '', channel: 1 }).rtspUrl, 'rtsp://10.0.0.5:8554/stream2');
});

test('normalizeInput: valida os campos', () => {
  assert.throws(() => normalizeInput(form({ nome: '  ' })), /apelido/i);
  assert.throws(() => normalizeInput(form({ ip: 'ip inválido!' })), /IP/);
  assert.throws(() => normalizeInput(form({ port: 70000 })), /Porta/);
  assert.throws(() => normalizeInput(form({ brand: 'xyz' })), /Marca/);
  assert.throws(() => normalizeInput({ nome: 'x', brand: 'custom', rtspUrl: 'http://a' }), /RTSP/);
  const c = normalizeInput(form());
  assert.strictEqual(c.port, 554);
  assert.strictEqual(c.channel, 1);
  assert.strictEqual(c.analyze, true);
});

test('normalizeInput: na edição, senha vazia mantém a atual e endereço mascarado mantém o atual', () => {
  const old = normalizeInput(form());
  const edited = normalizeInput(form({ nome: 'Quintal', password: '' }), old);
  assert.strictEqual(edited.password, 'p@ss:w/rd');
  assert.match(edited.rtspUrl, /p%40ss%3Aw%2Frd/);
  const custom = normalizeInput({ nome: 'x', brand: 'custom', rtspUrl: 'rtsp://u:segredo@1.2.3.4/live?subtype=1' });
  assert.strictEqual(custom.analyzerRtspUrl, 'rtsp://u:segredo@1.2.3.4/live?subtype=0');
  const again = normalizeInput({ nome: 'x', brand: 'custom', rtspUrl: maskUrl(custom.rtspUrl) }, custom);
  assert.strictEqual(again.rtspUrl, custom.rtspUrl);
});

test('publicCamera e maskUrl nunca devolvem a senha', () => {
  const c = normalizeInput(form());
  const pub = JSON.stringify(publicCamera(c));
  assert.ok(!pub.includes('p@ss') && !pub.includes('p%40ss'));
  assert.strictEqual(publicCamera(c).hasPassword, true);
  const custom = normalizeInput({ nome: 'x', brand: 'custom', rtspUrl: 'rtsp://u:segredo@1.2.3.4/live' });
  assert.ok(!JSON.stringify(publicCamera(custom)).includes('segredo'));
  assert.strictEqual(maskUrl('rtsp://u:segredo@h/p'), 'rtsp://u:***@h/p');
});

test('Registry: cria ids únicos, edita, remove e grava com permissão restrita', () => {
  const dir = tmp();
  const reg = new Registry(dir);
  assert.deepStrictEqual(reg.list(), []);
  const a = reg.save(form({ nome: 'Garagem' }));
  const b = reg.save(form({ nome: 'Garagem', ip: '192.168.0.11' }));
  const c = reg.save(form({ nome: 'Câmera da Frente' }));
  assert.deepStrictEqual([a.id, b.id, c.id], ['garagem', 'garagem-2', 'camera-da-frente']);
  assert.strictEqual(fs.statSync(reg.file).mode & 0o777, 0o600);
  reg.save({ id: 'garagem', nome: 'Garagem dos fundos', ip: '192.168.0.12' });
  assert.strictEqual(reg.get('garagem').nome, 'Garagem dos fundos');
  assert.strictEqual(reg.get('garagem').id, 'garagem');           // o id (nome da pasta) não muda ao renomear
  assert.match(reg.get('garagem').rtspUrl, /192\.168\.0\.12/);
  reg.remove('garagem-2');
  assert.deepStrictEqual(reg.list().map((x) => x.id), ['garagem', 'camera-da-frente']);
  assert.throws(() => reg.save({ id: 'nao-existe', nome: 'x', ip: '1.1.1.1' }), /não encontrada/);
  assert.throws(() => reg.remove('nao-existe'), /não encontrada/);
  assert.strictEqual(reg.resolve().id, 'garagem');
  assert.throws(() => reg.resolve('outra'), /não encontrada/);
});

test('Registry: apelido que parece data não vira id de data (pastas dd-mm-yyyy)', () => {
  const reg = new Registry(tmp());
  assert.match(reg.save(form({ nome: '01-02-2024' })).id, /^cam-/);
});

test('Registry: erro de gravação explica o que fazer', () => {
  const reg = new Registry(path.join(tmp(), 'nao', 'existe'));
  assert.throws(() => reg.save(form()), /setup\.sh/);
});

test('Registry.settings: guarda o telefone global e apaga com undefined', () => {
  const reg = new Registry(tmp());
  reg.saveSettings({ phone: '+5511999999999', whatsappDownMin: 7 });
  assert.strictEqual(reg.settings().phone, '+5511999999999');
  reg.saveSettings({ phone: undefined });
  assert.strictEqual(reg.settings().phone, undefined);
  assert.strictEqual(reg.settings().whatsappDownMin, 7);
});

test('migrateFromConfig: câmera única do config.json vira "Câmera 1" (legacy) e leva o telefone do gate.json', () => {
  const dir = tmp(), gate = tmp();
  fs.writeFileSync(path.join(gate, 'gate.json'), JSON.stringify({ phone: '+5579999999999', whatsappDownMin: 9 }));
  const reg = new Registry(dir);
  const cfg = { rtspUrl: 'rtsp://admin:s%40nha@192.168.15.158:554/cam/realmonitor?channel=1&subtype=1' };
  assert.strictEqual(migrateFromConfig(reg, cfg, gate, () => {}), true);
  const cam = reg.list()[0];
  assert.strictEqual(cam.id, 'camera-1');
  assert.strictEqual(cam.legacy, true);
  assert.strictEqual(cam.brand, 'intelbras');
  assert.strictEqual(cam.ip, '192.168.15.158');
  assert.strictEqual(cam.password, 's@nha');
  assert.strictEqual(cam.rtspUrl, cfg.rtspUrl);
  assert.match(cam.analyzerRtspUrl, /subtype=0$/);
  assert.deepStrictEqual(reg.settings(), { phone: '+5579999999999', whatsappDownMin: 9 });
  assert.strictEqual(migrateFromConfig(reg, cfg, gate, () => {}), false);   // só migra uma vez
});

test('migrateFromConfig: URL fora do padrão Dahua ou com analyzerRtspUrl vira câmera "custom"; sem rtspUrl não faz nada', () => {
  const reg = new Registry(tmp());
  migrateFromConfig(reg, { rtspUrl: 'rtsp://u:p@10.0.0.2/stream1', analyzerRtspUrl: 'rtsp://u:p@10.0.0.2/stream0' }, tmp(), () => {});
  assert.strictEqual(reg.list()[0].brand, 'custom');
  assert.strictEqual(reg.list()[0].analyzerRtspUrl, 'rtsp://u:p@10.0.0.2/stream0');
  const empty = new Registry(tmp());
  assert.strictEqual(migrateFromConfig(empty, {}, tmp(), () => {}), false);
  assert.deepStrictEqual(empty.list(), []);
});

test('FrameParser: separa quadros mesmo com o fluxo cortado em pedaços', () => {
  const frame = (body) => Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`), body, Buffer.from('\r\n')]);
  const jpegs = [Buffer.from([0xff, 0xd8, 1, 2, 3]), Buffer.from([0xff, 0xd8, 9, 9]), Buffer.from([0xff, 0xd8, 7])];
  const stream = Buffer.concat(jpegs.map(frame));
  const got = [];
  const p = new FrameParser((f) => got.push(f.jpeg));
  for (let i = 0; i < stream.length; i += 7) p.push(stream.subarray(i, i + 7));
  // o último quadro só está completo quando o seguinte começa
  assert.deepStrictEqual(got, jpegs.slice(0, 2));
  p.push(Buffer.from('--frame\r\n'));
  assert.deepStrictEqual(got, jpegs);
});

test('explain traduz os erros do ffmpeg e redact esconde a senha', () => {
  assert.match(explain('method DESCRIBE failed: 401 Unauthorized'), /usuário ou senha/);
  assert.match(explain('404 Not Found'), /caminho ou canal/);
  assert.match(explain('Connection refused'), /porta/);
  assert.match(explain('Connection timed out'), /alcançar/);
  assert.ok(!redact('erro em rtsp://admin:segredo@10.0.0.1/x').includes('segredo'));
  assert.ok(!explain('falha rtsp://admin:segredo@10.0.0.1/x desconhecida').includes('segredo'));
});
