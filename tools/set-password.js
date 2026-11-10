// Define usuário e senha do painel em config.json (campo "auth"), guardando só o hash (scrypt).
// Uso: printf '%s' "senha" | node tools/set-password.js usuario   (use ../set-password.sh, que pede a senha sem ecoar)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const user = process.argv[2];
const configPath = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json');
if (!user) { console.error('Informe o usuário.'); process.exit(1); }
const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (password.length < 8) { console.error('A senha precisa ter ao menos 8 caracteres.'); process.exit(1); }

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 32);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.auth = { user, passwordHash: `scrypt:${salt.toString('hex')}:${hash.toString('hex')}` };
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log(`Senha definida para o usuário "${user}".`);
