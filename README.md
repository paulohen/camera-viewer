# Camera Viewer

Sistema de câmeras IP (RTSP) para uso doméstico ou de pequeno comércio, que roda em Docker numa máquina Linux da rede local. Ele mostra as câmeras ao vivo (uma por vez ou em **grade**), reconhece pessoas, carros e animais, identifica rostos cadastrados, avisa por WhatsApp quando o portão fica aberto ou quando aparece um desconhecido à noite, e guarda tudo num painel web. **Aceita várias câmeras:** cada uma é cadastrada no painel (IP, usuário, senha e um apelido) e tem as suas próprias pastas de detecções, o seu portão e a sua garagem.

Este documento é a referência de operação. Para **instalar em outro computador, passo a passo**, siga o [`GUIA-INSTALACAO.md`](GUIA-INSTALACAO.md). Nenhuma senha está escrita aqui.

---

## Sumário

1. [O que o sistema faz](#1-o-que-o-sistema-faz)
2. [Arquitetura](#2-arquitetura)
3. [Estrutura do projeto](#3-estrutura-do-projeto)
4. [Instalação em um servidor novo](#4-instalação-em-um-servidor-novo)
5. [Configuração (referência)](#5-configuração-referência)
6. [Uso diário (as abas do painel)](#6-uso-diário-as-abas-do-painel)
7. [Como funciona por dentro](#7-como-funciona-por-dentro)
8. [Segurança](#8-segurança)
9. [Acesso de fora de casa (VPN)](#9-acesso-de-fora-de-casa-vpn)
10. [Backup e restauração](#10-backup-e-restauração)
11. [Solução de problemas](#11-solução-de-problemas)
12. [Limitações conhecidas e ideias futuras](#12-limitações-conhecidas-e-ideias-futuras)
13. [Referência da API interna](#13-referência-da-api-interna)
14. [Ambiente de referência](#14-ambiente-de-referência)
15. [Licença e créditos](#15-licença-e-créditos)
16. [Privacidade e aviso de uso](#16-privacidade-e-aviso-de-uso)

---

## 1. O que o sistema faz

| Recurso | Descrição |
|---|---|
| **Várias câmeras** | Cadastro no painel (aba **Câmeras**): apelido, IP, usuário e senha, com teste de conexão. Cada câmera tem pastas próprias de fotos, portão, garagem e carros. Câmeras novas valem em ~5 s, sem reiniciar. |
| **Ao vivo** | Escolha a câmera, ou veja todas ao mesmo tempo na **Grade** (MJPEG gerado pelo ffmpeg a partir do RTSP). O ffmpeg só roda enquanto alguém assiste. |
| **Detecção** | Movimento → YOLOv8 (pessoa, carro, moto, caminhão, ônibus, bicicleta, gato, cachorro). Roda no stream principal (1080p), só quando há movimento. |
| **Rostos** | Reconhece pessoas cadastradas (OpenCV YuNet + SFace), com votação entre vários quadros e rastreamento de cada pessoa. O cadastro de pessoas vale para todas as câmeras. |
| **Gravações** | Uma foto anotada por pessoa/objeto, em `<câmera>/dd-mm-yyyy/HH-MM-SS_<rótulo>.jpg` + `.json`. Aba com filtro por câmera (ou todas), dia e pessoa. |
| **Revisar rostos** | O sistema separa bons recortes de rosto; você aprova (vira cadastro) ou descarta com um clique. |
| **Pessoas** | Cadastro pelo painel: criar pessoa, enviar fotos (clicando ou arrastando), remover fotos, ver quais fotos não têm rosto detectável. Usa a pasta `faces/`. |
| **Carros e garagem** | Cadastre seus carros por capturas da câmera; avisa por WhatsApp (com foto) quando um carro determinado **para na garagem** (e, se quiser, quando sai ou quando um carro desconhecido para). |
| **Portão** | Compara uma região da imagem com fotos do portão fechado. Aberto por 2 min ⇒ alerta com foto. |
| **Alertas** | WhatsApp (via WAHA) com Telegram como reserva; o QR code do WhatsApp aparece no próprio painel. Desconhecido entre 18h e 7h, com foto. Avisos de câmera sem sinal e WhatsApp desconectado. Todo aviso diz de **qual câmera** veio. |
| **Limpeza** | Apaga fotos com mais de 30 dias (configurável). |
| **Login** | Painel protegido por usuário e senha (HTTP Basic, hash scrypt). |
| **VPN** | Acesso de fora de casa pelo Tailscale, sem abrir porta no roteador. |

---

## 2. Arquitetura

```
 Câmeras IP ──RTSP──┬──────────────► camera-viewer  (Node + ffmpeg, porta 8090)
 (uma ou várias)    │                  ├─ /stream (MJPEG de uma câmera) e /snapshot (quadros da grade)
                    │                  ├─ aba Câmeras: cadastro (grava cameras/cameras.json)
                    │                  ├─ abas Gravações / Revisar / Portão / Alertas / Carros
                    │                  └─ lê/escreve: fotos (SSD), faces/, faces_candidates/, gate/, cars/
                    │
                    └──RTSP──► camera-analyzer (Python: YOLO + OpenCV; uma thread por câmera)
                                 ├─ movimento → YOLO + rastreamento → rostos
                                 ├─ grava fotos no SSD (CAMERA_IMAGES_DIR/<câmera>/)
                                 ├─ monitor do portão e da garagem, alerta de desconhecido, avisos de saúde (por câmera)
                                 ├─ limpeza de fotos antigas (a cada 6 h)
                                 └─ envia alertas ──► camera-waha (WAHA, porta 3000 só em localhost)
                                                        └─► WhatsApp  (e Telegram como reserva)

 Celular/notebook fora de casa ══ VPN (Tailscale, criptografada) ══► camera-tailscale ──► painel :8090 do servidor
```

- Os 4 serviços (painel, analyzer, WAHA e VPN) sobem com **um único** `docker compose`.
- O painel e o analyzer **não se falam por rede**: trocam informação por arquivos (`cameras/cameras.json`, e a configuração, os comandos e o estado de cada câmera em `gate/<câmera>/` e `cars/<câmera>/`). É simples e sobrevive a reinícios.
- O analyzer relê `cameras/cameras.json` a cada ~5 s: cadastrar, editar ou remover uma câmera no painel inicia ou para a análise dela sem reiniciar o contêiner. Os modelos (YOLO e rostos) são carregados uma vez e divididos entre as câmeras: com **várias câmeras com movimento ao mesmo tempo, a análise de cada uma fica mais lenta** (a CPU é uma só).
- O WAHA fica acessível só em `127.0.0.1:3000` (painel do QR code). O analyzer fala com ele pela rede interna do Docker.

### Fluxo de um alerta de portão aberto

1. O analyzer compara, a cada 2 s, a região do portão com as referências do portão fechado.
2. Se a semelhança fica abaixo do limiar por 10 s seguidos, o estado vira **aberto** (isso ignora uma pessoa passando na frente).
3. Com o portão aberto há 2 min, envia a mensagem com a foto. Repete a cada 10 min (configurável). Ao fechar, avisa.

---

## 3. Estrutura do projeto

```
camera-viewer/
├── GUIA-INSTALACAO.md        # passo a passo para instalar em outro computador
├── docker-compose.yml        # os 3 serviços (viewer, analyzer, waha)
├── docker-compose.imagens.yml # complemento: usa as imagens prontas do ghcr.io em vez de construir (./setup.sh --imagens)
├── Dockerfile                # imagem do painel (Node 22 + ffmpeg)
├── server.js                 # servidor do painel: API, login
├── camera-registry.js        # cadastro de câmeras (cameras.json), endereços RTSP por marca, migração
├── live.js                   # ao vivo: um ffmpeg por câmera, stream contínuo e quadros da grade, teste de conexão
├── index.html                # página única do painel (abas)
├── analyzer/
│   ├── Dockerfile            # Python 3.11 + PyTorch (CPU) + modelos
│   ├── analyzer.py           # uma thread por câmera: detecção, rastreamento, rostos, grava fotos
│   ├── cameras.py            # lê cameras.json e migra as pastas do layout antigo (uma câmera)
│   ├── gate.py               # monitor do portão
│   ├── alerts.py             # alerta de desconhecido e avisos de saúde
│   ├── notify.py             # envio: WhatsApp (WAHA) e Telegram, com foto
│   ├── garage.py             # monitor da garagem e reconhecimento dos carros
│   ├── retention.py          # limpeza de fotos antigas
│   └── requirements.txt
├── tools/set-password.js     # grava o hash da senha do painel
├── set-password.sh           # pede usuário e senha e aplica
├── tests/, analyzer/tests/   # testes (node --test tests/*.test.js · python -m unittest discover -s analyzer/tests)
├── backup.sh                 # backup de configuração, segredos e cadastros
├── config.example.json       # modelo do config.json (sem segredos)
├── .env.example              # modelo do .env (sem segredos)
│
│   ── NÃO versionar (segredos e dados locais; veja .gitignore) ──
├── config.json               # WhatsApp/Telegram, ajustes do ao vivo, senha do painel (hash)
├── cameras/                  # cameras.json (câmeras e SENHAS delas) e settings.json (telefone que recebe os alertas etc.)
├── .env                      # senhas do WAHA, pasta das fotos, UID
├── faces/<nome>/             # fotos dos rostos cadastrados (e faces/people.json: nome de exibição e observação)
├── cars/<câmera>/            # cars.json (zona da garagem e carros), <carro>/ fotos de referência, _capturas/ pendentes
├── faces_candidates/<nome>/  # rostos coletados, à espera de revisão
├── gate/<câmera>/            # calibração e estado do portão (gate.json, state.json, refs/, latest.jpg)
├── waha_sessions/            # sessão do WhatsApp (mantém conectado)
├── tailscale_state/          # identidade do servidor na VPN (segredo)
└── CAMERA_IMAGES_DIR/        # as fotos: <câmera>/dd-mm-yyyy/HH-MM-SS_rotulo.jpg + .json (fora do projeto, ex.: SSD)
```

---

## 4. Instalação em um servidor novo

### 4.1. Requisitos

- Linux com **Docker** e **Docker Compose v2** (`docker compose version`). Testado com Docker 29 e Compose 5.
- **Atenção:** o Docker instalado por **snap** não enxerga pastas em `/tmp`. Mantenha o projeto dentro do seu `$HOME`.
- Rede com acesso à câmera (porta RTSP 554) e à internet (baixar imagens e falar com o WhatsApp).
- Para o desempenho que usamos: CPU com 8+ núcleos e 8+ GB de RAM, sem GPU. O consumo medido foi cerca de 14% de um núcleo parado e picos curtos quando há movimento.
- Espaço para as fotos (cada foto 1080p tem ~230 KB).
- Um celular com WhatsApp (de preferência de um número **reserva**, veja a seção [Segurança](#8-segurança)).

**Montagem fixa do disco das fotos (recomendado).** Discos externos ou secundários costumam ser montados só depois do login, e o caminho pode mudar (`/media/...` ou `/run/media/...`). Para o sistema voltar sozinho depois de um reinício, monte o disco num caminho fixo pelo `/etc/fstab` (exige `sudo`). Descubra o `UUID` com `lsblk -f` e adicione uma linha como esta (NTFS; troque `UUID`, `1000:1000` e o ponto de montagem):

```
UUID=SEU-UUID  /mnt/ssd3  ntfs3  uid=1000,gid=1000,nofail,x-systemd.automount,x-systemd.device-timeout=15,x-gvfs-hide  0  0
```

Antes, guarde uma cópia (`sudo cp /etc/fstab /etc/fstab.bak-camera`) e desmonte o disco do caminho antigo (`udisksctl unmount -b /dev/sdXN`, depois de parar o painel e o analyzer). Crie o ponto (`sudo mkdir -p /mnt/ssd3`), confira o arquivo (`sudo findmnt --verify`), rode `sudo systemctl daemon-reload` e **ligue a montagem automática** (`sudo systemctl start mnt-ssd3.automount`; sem isso ela só passa a valer no próximo boot). Teste com `ls /mnt/ssd3/cameraImages`. Por fim, ajuste `CAMERA_IMAGES_DIR="/mnt/ssd3/cameraImages"` no `.env`. Com `x-systemd.automount`, o primeiro acesso do Docker ao caminho monta o disco na hora, sem depender do login.

### 4.2. Passo a passo

> Este é o resumo. O passo a passo completo, para quem nunca instalou (Docker, rede, WhatsApp, onde achar o IP e o caminho RTSP de cada marca), está no [`GUIA-INSTALACAO.md`](GUIA-INSTALACAO.md).

> **Atalho:** depois de copiar o projeto, rode `./setup.sh`. Ele faz os passos 2 a 4 abaixo (cria as pastas, o `.env` com chaves aleatórias e o `config.json`, perguntando só o telefone que recebe os alertas) e **nunca sobrescreve** arquivos que já existem. Depois siga do passo 5. As câmeras **não** são pedidas aqui: você as cadastra no painel (passo 8).

**1. Copie o projeto** para o servidor (por exemplo, `~/camera-viewer`) e entre na pasta.

**2. Crie a pasta das fotos** (um disco grande, se possível) e anote o caminho:

```bash
mkdir -p "/caminho/para/cameraImages"
```

**3. Crie o `.env`:**

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Preencha: `CAMERA_IMAGES_DIR` (com aspas se tiver espaço), `UID_GID` (resultado de `echo "$(id -u):$(id -g)"`) e os valores do WAHA. Para gerar chaves aleatórias:

```bash
openssl rand -hex 24
```

**4. Crie o `config.json`:**

```bash
cp config.example.json config.json
chmod 600 config.json
nano config.json
```

Preencha `alerts.whatsappPhone` (telefone que **recebe**, formato `+55DDDNÚMERO`) e `alerts.wahaApiKey` (**o mesmo valor** de `WAHA_API_KEY` do `.env`). As câmeras **não** ficam no `config.json`: são cadastradas no painel. Veja a [referência](#5-configuração-referência).

**5. Construa e suba:**

```bash
docker compose up -d --build
```

Ou, sem construir nada, com as **imagens prontas** publicadas no ghcr.io (rode antes `./setup.sh --imagens`): `docker compose pull && docker compose up -d`. As imagens não levam segredos; veja a [seção 4.5](#45-imagens-prontas-ghcrio).

A primeira vez demora (baixa PyTorch, os modelos YOLO/YuNet/SFace e a imagem do WAHA; alguns GB). Acompanhe com `docker compose logs -f`.

**6. Conecte o WhatsApp** (uma vez só por servidor; cada servidor tem a **sua** sessão e a **sua** chave `WAHA_API_KEY`):
1. Abra o painel (`http://IP-DO-SERVIDOR:8090`), aba **Alertas**. Com o WhatsApp ainda desconectado aparece o **QR code** (se aparecer o botão **Conectar WhatsApp**, clique nele).
2. No celular que **vai enviar** os alertas: WhatsApp → **Aparelhos conectados** → **Conectar um aparelho** → leia o QR. O status vira **conectado ✓**.
3. Alternativa, na **própria máquina do servidor**: `http://localhost:3000/dashboard` (login no `.env`: `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`; se pedir a chave do servidor, use `WAHA_API_KEY`).
4. Se ninguém ler o QR em ~3 minutos, a sessão para sozinha: clique em **Conectar WhatsApp** de novo ou rode `docker compose restart waha`.

**7. Proteja o painel com senha:**

```bash
./set-password.sh
```

**8. Cadastre as câmeras** (aba **Câmeras**): para cada uma, informe o **apelido** (ex.: Garagem), a marca, o **IP**, o usuário e a **senha** e clique em **Testar conexão** (mostra uma imagem se estiver tudo certo) e depois em **Salvar câmera**. A análise dela começa em alguns segundos. Repita para cada câmera da rede.

**8b. Cadastre os rostos** (opcional): aba **Pessoas** (ou crie `faces/<nome>/` com 5 a 10 fotos de cada pessoa, de frente, boa luz). O analyzer recarrega sozinho em ~30 s. Vale para todas as câmeras. Depois de alguns dias, use a aba **Revisar rostos** para aumentar a base com fotos das próprias câmeras.

**9. Calibre o portão** (aba **Portão**, escolhendo a câmera que o enxerga):
1. Arraste sobre a imagem para marcar só a região do portão e clique em **Salvar região**.
2. Com o portão **fechado**, clique em **Adicionar referência**. Repita à noite (e em outras condições de luz).
3. Opcional: com o portão **aberto**, clique em **Calibrar com portão aberto**. O limiar é ajustado sozinho.

**10. Teste os alertas** (aba **Alertas**): botão **Testar WhatsApp**. A mensagem chega com uma foto do momento.

**11. (Recomendado) Configure o Telegram como reserva**, veja a [seção 5.4](#54-telegram-reserva).

**12. (Opcional) Acesso de fora de casa:** configure a VPN, veja a [seção 9](#9-acesso-de-fora-de-casa-vpn).

### 4.3. Checklist rápido

- [ ] `.env` e `config.json` criados, com permissão `600`
- [ ] `docker compose up -d --build` sem erros e `docker compose ps` com 3 serviços `Up`
- [ ] QR code lido; WhatsApp **conectado ✓** na aba Alertas
- [ ] Câmeras cadastradas na aba Câmeras, cada uma com **Testar conexão** ok
- [ ] `./set-password.sh` executado
- [ ] Região e referência do portão salvas
- [ ] Teste de WhatsApp recebido (com foto)
- [ ] VPN (opcional): chave gerada, `tailscale.env` preenchido, serviço no ar e expiração da chave desligada
- [ ] `./backup.sh` executado e guardado em outro lugar

### 4.4. Atualizar

```bash
./setup.sh                      # só cria o que faltar (a pasta cameras/, por exemplo); não mexe no que já existe
docker compose up -d --build     # ou, com imagens prontas: docker compose pull && docker compose up -d
```

reconstrói só o que mudou. As imagens base e o ultralytics não estão com versão fixa; se quiser reprodutibilidade total, fixe as versões em `analyzer/requirements.txt` e na linha `image:` do WAHA.

**Atualizando uma instalação de UMA câmera (versão antiga):** nada a fazer além dos comandos acima. Na primeira subida, o painel cadastra a câmera do `config.json` como **"Câmera 1"** (renomeie na aba Câmeras; o apelido pode mudar, a pasta continua `camera-1`) e o analyzer **move** as fotos, o portão, a garagem e os carros antigos para as pastas dela (`cameraImages/camera-1/`, `gate/camera-1/`, `cars/camera-1/`). O telefone escolhido na aba Alertas passa a valer para todas as câmeras. É um `mv` dentro do mesmo disco, não copia as fotos. Depois disso o `rtspUrl` do `config.json` não é mais usado e pode ser apagado.

### 4.5. Imagens prontas (ghcr.io)

O workflow `.github/workflows/publish.yml` constrói o painel (`camera-viewer-painel`) e o analyzer (`camera-viewer-analyzer`) e os publica em `ghcr.io/<dono>/`. Ele roda ao criar uma tag de versão (`git tag v1.0.0 && git push origin v1.0.0`) ou manualmente na aba **Actions**. As imagens são só para **x86 (amd64)**.

- **Segredos ficam de fora:** `config.json`, `.env`, `cameras/` e `waha_sessions/` são montados em cada computador pelo compose; a sessão do WhatsApp é lida por QR code em cada máquina.
- **Quem usa:** `./setup.sh --imagens` (grava `COMPOSE_FILE=docker-compose.yml:docker-compose.imagens.yml` no `.env`), `docker compose pull`, `docker compose up -d`. Variáveis opcionais no `.env`: `CAMERA_VIEWER_REGISTRY` (padrão `ghcr.io/paulohen`) e `CAMERA_VIEWER_TAG` (padrão `latest`).
- **Pacotes públicos:** o ghcr.io cria os pacotes como privados. Torne-os públicos (Packages ▸ Package settings ▸ Visibility) ou faça `docker login ghcr.io` com um token `read:packages` em cada computador.
- **Sem registro:** `docker save` nas imagens, copie o arquivo e `docker load` no outro computador.

---

## 5. Configuração (referência)

### 5.1. `config.json`

| Campo | Para que serve |
|---|---|
| `port`, `fps`, `width`, `quality` | Porta do painel (se mudar, mude também o mapeamento `8090:8090` no compose) e a transcodificação do ao vivo de **uma** câmera: fps, largura e qualidade JPEG do ffmpeg (menor número = melhor). |
| `gridWidth`, `gridFps`, `gridQuality` | O mesmo para a **Grade** (padrão 640 px, 5 quadros/s, qualidade 8): quadros menores e mais lentos, para caber várias câmeras. |
| `rtspUrl` (antigo) | Só lido **uma vez**, na atualização de uma instalação de uma câmera (veja 4.4): vira a "Câmera 1" do cadastro. Depois pode ser apagado. As câmeras ficam em `cameras/cameras.json`. |
| `liveDelaySec` | Buffer anti-travamento do ao vivo, em segundos (padrão 2; `0` desliga). O vídeo chega atrasado esse tempo, mas paradas menores que ele não aparecem. Aumente (3 a 4) se a rede da câmera for muito instável. |
| `retentionDays` | Dias de fotos mantidos. Padrão 30. `0` desliga a limpeza. |
| `auth.user`, `auth.passwordHash` | Login do painel. **Não edite à mão:** use `./set-password.sh`. Sem esse campo o painel fica aberto. |
| `alerts.whatsappPhone` | Telefone padrão que recebe os alertas. Pode ser trocado na aba Alertas (essa troca fica em `cameras/settings.json`, vale para todas as câmeras e tem prioridade). |
| `alerts.wahaUrl` | `http://waha:3000` (nome do serviço na rede do Docker). |
| `alerts.wahaApiKey` | Mesmo valor de `WAHA_API_KEY` do `.env`. |
| `alerts.wahaSession` | Nome da sessão do WAHA (`default`). |
| `alerts.telegramBotToken`, `alerts.telegramChatId` | Reserva por Telegram (opcional). |

Depois de editar o `config.json`, reinicie: `docker compose restart analyzer camera-viewer`.

### 5.2. `.env`

| Variável | Para que serve |
|---|---|
| `CAMERA_IMAGES_DIR` | Pasta das fotos (fora do projeto). Se o caminho não existir, os serviços **não sobem** (de propósito: evita gravar no disco errado quando o SSD não está montado). |
| `UID_GID` | Dono das pastas do projeto (`id -u:id -g`). Os contêineres do painel e do analyzer rodam com esse usuário. |
| `WAHA_API_KEY` | Chave da API do WAHA. |
| `WAHA_DASHBOARD_USERNAME`, `WAHA_DASHBOARD_PASSWORD` | Login do painel do WAHA (QR code). |
| `WHATSAPP_SWAGGER_USERNAME`, `WHATSAPP_SWAGGER_PASSWORD` | Login da documentação interativa da API do WAHA. |
| `WHATSAPP_DEFAULT_ENGINE` | `NOWEB` (sem navegador, leve). Outras: `GOWS`, `WEBJS`. Se mudar, mude também a tag da imagem no compose. |
| `WHATSAPP_START_SESSION` | `default`: inicia a sessão sozinha ao subir. |
| `WAHA_PRINT_QR` | `false`: não imprime o QR nos logs. |

### 5.1b. `cameras/cameras.json` e `cameras/settings.json` (geridos pelo painel, não precisa editar)

`cameras.json` guarda as câmeras **e as senhas delas** (arquivo `600`, nunca versionar; o painel nunca devolve a senha ao navegador). Cada câmera:

| Campo | Significado |
|---|---|
| `id` | Nome da pasta da câmera (`cameraImages/<id>`, `gate/<id>`, `cars/<id>`). Sai do apelido na criação e **não muda** ao renomear. |
| `nome` | Apelido, só para você diferenciar. Aparece nas abas e em todo alerta. |
| `brand`, `ip`, `port`, `user`, `password`, `channel` | Marca (`intelbras` = Intelbras/Dahua, `hikvision`, `tapo`, `reolink` ou `custom`), endereço, usuário, senha e canal. O painel monta o endereço RTSP certo da marca: o stream leve para o ao vivo e o principal (alta resolução) para a análise. |
| `rtspUrl`, `analyzerRtspUrl` | Endereços RTSP calculados (ou digitados, em `custom`). |
| `analyze` | `false` = só ao vivo, sem detecção (poupa processador). |
| `enabled` | `false` = câmera desligada. |
| `legacy` | Marca a "Câmera 1" vinda de uma instalação antiga (dona das pastas antigas). |

`settings.json`: `phone` (telefone que recebe), `whatsappAlertEnabled` e `whatsappDownMin` (aviso de WhatsApp desconectado).

### 5.2b. `cars/<câmera>/cars.json` (gerido pela página, não precisa editar)

| Campo | Padrão | Significado |
|---|---|---|
| `garage` | — | Zona da garagem `{x,y,w,h}` em fração da imagem. Sem ela, o monitor fica desligado. |
| `stopSec` | 20 | Segundos parado para considerar que "parou" (5 a 600). |
| `threshold` | 0.40 | Nota mínima (0,30 a 0,99) para reconhecer um carro cadastrado. |
| `alertUnknown` | false | Avisar quando um carro não cadastrado parar. |
| `cars.<slug>` | — | `nome`, `alertOnPark` (avisar ao parar) e `alertOnLeave` (avisar ao sair). As fotos ficam em `cars/<slug>/`. |

### 5.3. `gate/<câmera>/gate.json` (gerido pela página, não precisa editar)

Criado pelas abas Portão e Alertas, uma por câmera. Campos:

| Campo | Padrão | Significado |
|---|---|---|
| `roi` | — | Região do portão `{x,y,w,h}` em fração (0 a 1) da imagem. Mudar a região apaga as referências. |
| `threshold` | 0.6 | Similaridade abaixo disso ⇒ portão aberto. |
| `debounceSec` | 10 | O novo estado precisa durar isso para valer. |
| `alertAfterMin` / `repeatMin` / `notifyClosed` / `enabled` | 2 / 10 / true / true | Alerta de portão aberto: tempo, repetição (0 = não repete), aviso ao fechar, liga/desliga. |
| `unknownEnabled` / `unknownFrom` / `unknownTo` | true / 18:00 / 07:00 | Alerta de pessoa desconhecida e janela (pode virar a meia-noite). |
| `unknownCooldownMin` | 5 | Intervalo mínimo entre alertas de desconhecido. |
| `unknownIncludeNoFace` | false | Também avisa pessoa cujo rosto não apareceu. Gera muito ruído com câmera alta. |
| `healthEnabled` / `cameraDownMin` | true / 5 | Aviso de câmera sem sinal (o de WhatsApp desconectado é global: `cameras/settings.json`). |

Arquivos em `gate/<câmera>/`: `gate.json` (configuração), `state.json` (estado, escrito pelo analyzer), `cmd.json` (comando pedido pela página, apagado após executar), `latest.jpg` (último quadro), `refs/` (referências do portão fechado). Em `gate/` fica também `faces_status.json` (comum a todas as câmeras).

### 5.4. Telegram (reserva)

O Telegram é gratuito, oficial e envia fotos. Serve de reserva se o WhatsApp falhar e é o **único** canal do aviso "WhatsApp desconectado".

1. No Telegram, converse com **@BotFather**, envie `/newbot` e siga as instruções. Ele devolve o **token** do bot.
2. Abra o seu bot no Telegram e envie qualquer mensagem (por exemplo, "oi").
3. Descubra o seu `chat_id`: abra no navegador `https://api.telegram.org/bot<TOKEN>/getUpdates` (troque `<TOKEN>`). Procure `"chat":{"id": ...}` e copie o número.
4. Coloque em `config.json`: `alerts.telegramBotToken` e `alerts.telegramChatId`. Reinicie: `docker compose restart analyzer`.
5. Na aba **Alertas**, clique em **Testar Telegram**.

### 5.5. Ajuste fino do analyzer (variáveis de ambiente)

Opcional. Para mudar, adicione em `environment:` do serviço `analyzer` no compose. Valem para todas as câmeras.

| Variável | Padrão | Significado |
|---|---|---|
| `ANALYZE_FPS` | 8 | Quadros analisados por segundo quando há movimento (o limite real é a velocidade da CPU: ~115 ms por quadro com pessoa). |
| `MOTION_MIN_AREA` | 0.005 | Fração do quadro em movimento para disparar a análise. |
| `MOTION_HOLD` | 4 | Segundos que continua analisando após o último movimento. |
| `OBJECT_CONF` | 0.40 | Confiança mínima do YOLO. |
| `SOLO_CONF` | 0.60 | Uma passagem com uma única detecção só vale se tiver essa confiança. |
| `SEQ_EVERY` / `SEQ_MAX` | 1.5 / 4 | Foto de acompanhamento a cada tantos segundos / máximo por passagem (`0` desliga as de acompanhamento). |
| `FACE_DETECT_WIDTH` | 960 | Largura em que os rostos são procurados (1080p inteiro é 4x mais lento; as coordenadas voltam à escala original). |
| `COOLDOWN` | 6 | Segundos sem salvar a *foto final* do mesmo rótulo de novo (as de acompanhamento não contam). |
| `TRACK_TTL` | 3 | Segundos sem ver o objeto para considerar que saiu de cena. |
| `UNKNOWN_AFTER` | 10 | Segundos em cena sem identificar ⇒ salva como desconhecida. |
| `FACE_THRESHOLD` | 0.363 | Similaridade mínima para reconhecer um rosto. Subir reduz falsos positivos (e reconhece menos). |
| `MIN_FACE` | 40 | Largura mínima (px) de rosto usado para identificar. |
| `CAND_PER_TRACK` / `CAND_MAX` | 3 / 30 | Recortes guardados por passagem / máximo pendente por pessoa. |
| `CAND_MIN_FACE` / `CAND_DEDUP` | 60 / 0.75 | Largura mínima do candidato / similaridade acima da qual é considerado repetido. |
| `YOLO_MODEL` | yolov8s | Modelo YOLO (caminho do arquivo `.pt`). |

---

## 6. Uso diário (as abas do painel)

Abra `http://IP-DO-SERVIDOR:8090` e entre com o usuário e a senha definidos.

- **Ao vivo** — escolha a câmera pelos botões do topo (o apelido de cada uma), ou **▦ Grade** para ver todas ao mesmo tempo (clique numa câmera da grade para ver só ela; **⛶ Tela cheia** para um monitor de parede). O stream só consome recursos enquanto a aba está aberta. A escolha fica lembrada no navegador.
- **Câmeras** — cadastro: **apelido**, marca, **IP**, porta, usuário, **senha** e canal; **Testar conexão** mostra uma imagem antes de salvar e explica o erro (senha errada, IP inalcançável, caminho errado). Cada câmera cadastrada mostra se a análise dela está funcionando e tem **Ver ao vivo**, **Editar** (senha em branco mantém a atual) e **Remover** (as fotos já gravadas **não** são apagadas: ficam em `cameraImages/<câmera>`). Desmarque *Analisar esta câmera* para só assistir ao vivo. Em **Outra marca** informe o endereço RTSP completo.
- **Gravações** — escolha a **câmera** (ou *Todas as câmeras*), o **dia** e filtre por **pessoa/objeto** (cada pessoa tem um botão com a contagem). Cada ocorrência mostra a foto ao lado, a hora, o tempo em cena e a confiança. Clique na foto para ver em tamanho completo (setas ← → navegam, Esc fecha). A linha de baixo mostra o espaço em disco e a regra de limpeza.
- **Portão** — estado atual (Fechado, ABERTO ou Sem calibração), similaridade e calibração, **da câmera escolhida no topo**. Veja o passo 9 da instalação.
- **Alertas** — o que vale para **todas as câmeras**: telefone que recebe, estado e **QR code do WhatsApp**, Telegram, testes e o aviso de WhatsApp desconectado. Abaixo, escolhendo a câmera: regras do alerta de desconhecido e do aviso de câmera sem sinal, só dela.
- **Revisar rostos** — o contador vermelho no menu mostra os pendentes. Em cada grupo: **Aprovar** copia a foto para `faces/<nome>/`; **Descartar** apaga. Em "Desconhecidas", digite o nome para cadastrar uma pessoa nova. O reconhecimento passa a usar as fotos novas em ~30 s.
- **Pessoas** — lista as pastas de `faces/`. **Nova pessoa**: digite o nome. **Adicionar fotos**: clique ou arraste as imagens (JPG, PNG ou WEBP, até 10 MB cada). Cada foto mostra **✓ rosto** (o reconhecimento a usa) ou **⚠ sem rosto** (o analyzer não achou um rosto: troque por outra). **Editar** muda o nome de exibição e a observação (a pasta continua a mesma, para não quebrar as fotos antigas). **Excluir pessoa** apaga as fotos cadastradas. Idealmente 5 a 10 fotos de frente, com boa luz.
- **Carros** — veja a seção 7.6. Cada câmera tem a sua garagem e os seus carros (escolha a câmera no topo). Desenhe a garagem, capture os carros com a câmera, dê nomes, escolha quando avisar e acompanhe, ao vivo, o que está na garagem e a nota de semelhança de cada carro.

### Comandos úteis (rode dentro da pasta do projeto)

```bash
docker compose ps                         # estado dos serviços
docker compose logs -f analyzer           # acompanhar o analyzer
docker logs --tail 50 camera-analyzer     # funciona de qualquer pasta
docker compose restart analyzer           # reiniciar só o analyzer
docker compose up -d --build              # aplicar mudanças de código
docker compose down                       # parar tudo (os dados ficam)
```

---

## 7. Como funciona por dentro

### 7.1. Detecção e fotos

1. O analyzer abre uma thread por câmera cadastrada. Cada uma lê o stream principal da sua câmera continuamente e guarda só o quadro mais recente. Os modelos de YOLO e de rostos são um só, usados por uma câmera de cada vez.
2. Compara quadros (subtração de fundo) para saber se há **movimento**. Sem movimento, nada pesado roda.
3. Com movimento, o **YOLOv8** detecta objetos e o rastreador (ByteTrack) dá um **ID** a cada pessoa/objeto, seguindo-o entre quadros.
4. Cada pessoa em cena é uma **passagem**, seguida por um rastreador próprio que já a reconhece no primeiro quadro (o ByteTrack só confirmava depois de 2 quadros e, com a exigência extra, uma passagem curta passava em branco). Uma passagem vale com 2+ detecções, ou com uma só se ela tiver confiança de pelo menos 0,60. Objetos que não são pessoa (carro, moto, animais) só valem se a própria caixa do objeto se deslocar (mais de ~40% de mudança): um carro estacionado, mesmo com alguém passando na frente, não vira foto.
   **Gato/cachorro falsos:** visto de cima e de costas, uma pessoa inclinada às vezes sai como "cachorro" (chegou a 0,91) ou "gato" (0,63), na mesma posição da caixa de pessoa. Por isso um animal só vale se a caixa **não estiver sobre uma pessoa** (a do quadro ou uma passagem de pessoa ativa) e **não for mais alta que 1,5x a largura** (animal de quatro patas é mais largo que alto; pessoa em pé, o contrário).
5. Cada passagem gera **fotos de acompanhamento** (uma a cada 1,5 s enquanto a pessoa está em cena, até 4) e **uma foto final**, a melhor, com a identidade confirmada ou, se saiu sem identificar, `pessoa-desconhecida`/`pessoa`. As de acompanhamento ficam com o nome só depois de confirmado; antes, saem como `pessoa` (na página, "pessoa (sem identificação)") e **nunca disparam alerta**.
6. O log do analyzer mostra cada passagem, por exemplo `passagem pessoa #12: 9 detecções em 3.4 s, 5 foto(s)`. Passagens descartadas por terem pouca evidência também aparecem (`descartada pessoa #13: ...`).

### 7.2. Reconhecimento de rostos

- O **YuNet** detecta rostos e o **SFace** gera uma "impressão" numérica de cada um, comparada por semelhança de cosseno com as fotos de `faces/`.
- Só rostos **inteiros** (sem tocar a borda da imagem) e com pelo menos 40 px votam.
- Uma pessoa é confirmada com **2 votos iguais**, ou 1 voto forte (≥ 0,5). Rosto detectado mas sem correspondência vira `pessoa-desconhecida`; se nenhum rosto bom apareceu, o rótulo é só `pessoa`.
- Com a câmera de cima, o rosto costuma aparecer pequeno ou cortado no topo; por isso muitas passagens saem como `pessoa`.

### 7.3. Candidatos a cadastro

Ao fim de cada passagem, o sistema separa até 3 recortes **limpos** (sem caixas) de rostos de frente, nítidos e com 60+ px, descartando os quase iguais a algo que já existe. Ficam em `faces_candidates/<nome>/` (ou `_desconhecida/`) e **não entram no reconhecimento** até você aprovar. Assim, um erro de identificação não se reforça sozinho.

### 7.4. Portão

- A região marcada é reduzida a 128×128 em tons de cinza e comparada com cada referência por **correlação normalizada** (`TM_CCOEFF_NORMED`). Esse método ignora diferenças de brilho e contraste, então a noite não dispara alarme.
- A similaridade é a **maior** entre as referências. Por isso vale adicionar uma referência de dia e outra de noite.
- Mudar a região apaga as referências (elas seriam de outro recorte).
- O estado persiste em `gate/<câmera>/state.json`: se o analyzer reiniciar com o portão aberto, o relógio dos 2 minutos continua.
- **Luz que muda devagar não é abertura.** O sol andando pelo piso perto do portão derruba a nota aos poucos (num dia de teste a nota foi de 0,93 às 07:52 para ~0,69 às 09:22, no limiar, e gerou 3 alertas falsos). Um portão que abre muda a cena **de repente**. Por isso o monitor só considera "aberto" se a nota ficou abaixo do limiar **e** caiu pelo menos 0,12 em relação ao nível "fechado" dos últimos ~5 minutos. Uma queda lenta é registrada no log ("nota baixou devagar... mudança de luz") e ignorada.
- **Referências automáticas.** Com o portão claramente fechado, a cena parada por 1 minuto (nota estável), sem pessoa/carro/animal em cena há 30 s e a nota num patamar plausível (de limiar+0,03 a 0,88), o monitor guarda a imagem atual como referência (`gate/refs/auto_*.png`, no máximo uma a cada 10 minutos, até 6; as mais antigas saem). Assim as referências acompanham o sol sem você treinar de novo. As suas referências manuais (`closed_*.png`) nunca são apagadas, só por "Limpar referências".
- **Volta a "fechado"** quando a nota passa do limiar **ou** chega a 0,08 do nível de antes de abrir (com sol forte o nível normal já é baixo).
- A aba Portão mostra quantas referências são automáticas.

### 7.5. Alertas

- **Canais:** WhatsApp primeiro; se falhar (ou estiver desconectado), o Telegram assume. O aviso "WhatsApp desconectado" usa só o Telegram.
- **Desconhecido:** só dentro da janela (18h–7h por padrão), com intervalo mínimo entre alertas e foto anexa. Pessoas conhecidas nunca disparam.
- **Saúde:** câmera sem quadros por 5 min (cada câmera avisa a sua) e WhatsApp fora por 5 min (um aviso só, para todas) geram aviso, uma vez; o retorno também é avisado.
- **De qual câmera:** todo aviso termina com `📷 <apelido da câmera>`. Se você renomeia uma câmera, o analyzer reinicia a análise dela (~5 s) para usar o apelido novo.
- **O número de destino** é resolvido no WhatsApp antes do envio (isso corrige o 9º dígito de números brasileiros antigos).

### 7.6. Garagem e carros

**O que faz.** Você marca na imagem a área da **garagem** e cadastra seus carros. A cada 4 s (mesmo sem movimento) o analyzer procura, dentro da zona, o **padrão de cada carro cadastrado**:
- Um carro **parou** quando o padrão dele aparece e fica no mesmo lugar por `stopSec` segundos (padrão 20 s). Carro apenas passando, ou ainda andando, não conta.
- Um carro **saiu** quando o padrão some por 3 ciclos seguidos (12 s). Uma pessoa na frente por poucos segundos não conta como saída.
- O que já estava na garagem quando o analyzer iniciou, e um carro cadastrado enquanto já está lá, **não geram aviso**.
- O mesmo carro que sai e volta em menos de 2 minutos não gera novo aviso.
- Cada evento grava uma foto no padrão das Gravações (`carro-<nome>`, com "parou" ou "saiu" no cartão) e, se configurado, manda o aviso com foto. **A foto do "saiu" mostra o carro** (o último quadro em que ele estava lá), não a vaga vazia.

**Como cadastrar.** Na aba Carros: (1) desenhe e salve a garagem em volta da vaga; (2) com o carro **estacionado**, clique em "Capturar carros da garagem agora"; (3) em cada captura escolha o carro ou "Novo carro…" e digite o nome; (4) repita em outro horário (dia e noite), pois a mesma câmera vê o carro diferente. Por carro há duas opções: *avisar quando parar* (ligada por padrão) e *avisar quando sair*. A opção *avisar também carro não cadastrado* é **beta** e vem desligada.

**Como reconhece (e por que assim).** Foram testados quatro métodos com imagens reais desta câmera. Só o último serviu:

| Método | O que se viu |
|---|---|
| Classe "car" do YOLO | **Falha:** visto de cima e de perto, o carro grande é chamado de **"airplane"** (0,5 a 0,75), e "car" quase não aparece. Pior: a **parede branca** da direita também vira "airplane", e um carro da rua visto pelo portão vira "car" com 0,88. |
| Rede neural genérica + cor | **Falha:** o mesmo carro deu 0,73 entre duas fotos, e a **cor chegou a cair de 0,97 para 0,11** em segundos (a câmera muda o balanço de branco e a exposição). |
| Comparar com uma foto de "garagem vazia" | **Falha:** o sol e as sombras mudam tanto as bordas do piso que a garagem vazia em outra hora parecia diferente da referência (0,10 a 0,23). |
| **Procurar o padrão do carro cadastrado** (bordas + correlação) | **Usado.** Não depende de cor, brilho nem de acertar o rótulo do YOLO. Medido nesta câmera: carro cadastrado presente **0,50 a 0,98**; garagem sem ele **0,19 a 0,23**. |

**Validação com as fotos reais de um dia de uso.** O monitor foi "reproduzido" sobre as fotos reais (cada foto vale até a próxima). Eventos gerados: **saiu 13:03:50, parou 14:05:30, saiu 16:18:35**, exatamente o que aconteceu, sem nenhum falso evento (nem a parede, nem o carro da rua, nem pessoas).

**O defeito que isso corrigiu.** A primeira versão procurava "um veículo" com o YOLO e depois tentava descobrir qual era. A parede branca (detectada como "avião") virou um "carro não cadastrado que parou", e como já ocupava a vaga, o retorno do carro **não gerou evento**. Por isso hoje o YOLO só é usado para **capturar fotos de referência** e, com a opção ligada, para carros desconhecidos (apenas classe carro/caminhão com confiança de pelo menos 0,5, o que exclui a parede).

A nota mínima padrão é **0,40** (aba Carros → Ajustes). A tela mostra, para cada carro cadastrado, a nota atual e se está "na garagem" ou "fora": use isso para calibrar.

**Limites (leia antes de confiar):**
- Carros do **mesmo modelo** parados no mesmo lugar podem ser confundidos. Se dois carros cadastrados casarem no mesmo lugar, vale o de maior nota. A **placa não é lida** (a câmera é de cima).
- **Ainda não foi testado com dois carros diferentes cadastrados** (só um deles tinha fotos). Cadastre o segundo carro e confira as notas na tela.
- Se a luz muda muito (de dia para noite) ou o carro estaciona diferente (porta aberta, outra posição), capture uma foto de referência em cada situação.
- O monitor vê **uma zona**. Desenhe-a em volta da vaga. Se um carro seu aparecer como "fora" estando lá, suba a nota mínima apenas se necessário e capture uma foto nova.

### 7.7. Limpeza

Na partida e a cada 6 h, cada câmera apaga as fotos da sua própria pasta de dias anteriores a `retentionDays`. Só mexe em pastas `dd-mm-yyyy`, só apaga `HH-MM-SS_*.jpg/.json`, ignora links e outras pastas, e só remove a pasta se ficar vazia.

---

## 8. Segurança

- **Login do painel:** HTTP Basic com senha guardada como hash scrypt. Depois de 10 senhas erradas seguidas, o IP é bloqueado por 10 minutos. O Basic Auth **não criptografa** o tráfego: dentro da rede local é aceitável; **nunca exponha a porta 8090 à internet**. Para acesso de fora de casa, use a **VPN** (seção 9).
- **Sem senha ativa:** o servidor imprime um aviso ao iniciar e a página fica aberta a qualquer aparelho da rede (que poderia aprovar/descartar rostos e mudar a calibração).
- **Segredos:** `config.json` (chave do WAHA, hash do painel), `cameras/cameras.json` (as **senhas das câmeras**, em texto) e `.env` ficam com permissão `600` e fora do controle de versão. Troque a senha da câmera se ela vazar. O painel nunca devolve a senha de uma câmera ao navegador (ao editar, deixe em branco para manter). Quem entra no painel pode cadastrar câmeras (o painel passa a falar com o endereço informado): mantenha a senha do painel.
- **WhatsApp não oficial:** o WAHA se conecta como "aparelho vinculado". O WhatsApp pode bloquear números que considere suspeitos. Use um **número reserva** (não o principal) e poucas mensagens. Se o aparelho for desvinculado, a aba Alertas mostra "desconectado" e basta ler o QR de novo.
- **Enviar para o próprio número** que está conectado faz a mensagem cair em "Mensagem para você mesmo", sem notificação. Use um telefone de destino diferente do que está conectado.
- **Painel do WAHA** só aceita conexões do próprio servidor (`127.0.0.1:3000`).
- **Pastas protegidas:** o servidor valida nomes de pasta e de arquivo em todas as rotas de imagem e rejeita tentativas de sair delas.

---

## 9. Acesso de fora de casa (VPN)

Para ver a câmera e receber o painel fora da rede local, usamos o **Tailscale**: uma VPN baseada em WireGuard, gratuita para uso pessoal. Os seus aparelhos e o servidor formam uma rede privada e criptografada; **nenhuma porta é aberta no roteador** e funciona mesmo atrás de CGNAT (comum em operadoras brasileiras).

> **Nunca** faça redirecionamento de porta (port forwarding) da 8090 no roteador. O painel usa HTTP e senha simples: só é seguro dentro da rede local ou da VPN.

### 9.1. Ativar no servidor (uma vez)

O serviço `tailscale` está no `docker-compose.yml` (roda com `network_mode: host`, então o servidor inteiro fica alcançável pelo IP da VPN). Ele **só sobe quando pedido**.

> **Por que chave e não o link de login?** No modo "link", o contêiner espera só ~60 s pelo seu login, desiste e reinicia, gerando um link novo a cada minuto (você nunca consegue concluir; chegamos a 1.200 reinícios). Com uma **chave de autenticação**, o login é automático.

1. **Gere uma chave** em https://login.tailscale.com/admin/settings/keys → **Generate auth key**. Deixe **Reusable** e **Ephemeral** desligados (uso único) e escolha uma expiração curta (por exemplo, 1 dia). Se pedir, marque **Pre-approved**. Copie a chave (`tskey-auth-...`); ela só aparece uma vez.
2. **Coloque a chave no servidor:**

```bash
cp tailscale.env.example tailscale.env
chmod 600 tailscale.env
nano tailscale.env        # troque o texto depois de TS_AUTHKEY= pela chave
```

3. **Suba o serviço:**

```bash
docker compose up -d tailscale
```

4. **Confira** que conectou e descubra o IP da VPN (começa com `100.`):

```bash
docker exec camera-tailscale tailscale status
docker exec camera-tailscale tailscale ip -4
```

5. **Apague a chave** do `tailscale.env` (ela já foi usada; a identidade do servidor fica guardada em `tailscale_state/`). Depois, `docker compose up -d tailscale` de novo não pede login.
6. **Desligue a expiração da chave** deste servidor. Por padrão ela vence em 180 dias e o servidor sairia da VPN sem aviso. Em https://login.tailscale.com/admin/machines, no menu `...` da máquina `camera-viewer`, escolha **Disable key expiry**.

### 9.2. Usar nos seus aparelhos

1. Instale o app **Tailscale** (Android, iOS, Windows, Mac, Linux) e entre **com a mesma conta**.
2. Com a VPN ligada, abra no navegador `http://camera-viewer:8090` (nome da máquina na VPN, via MagicDNS) ou `http://IP-DA-VPN:8090` (o IP que começa com `100.`).
3. Entre com o usuário e a senha do painel, como em casa.

Os dados da VPN já vão criptografados; o aviso "não seguro" do navegador (HTTP) é esperado. Se quiser HTTPS, ative **HTTPS Certificates** em https://login.tailscale.com/admin/dns e rode `docker exec camera-tailscale tailscale serve --bg 8090`.

### 9.3. O que fica acessível pela VPN

- Só os seus aparelhos logados na mesma conta enxergam o servidor.
- Como o contêiner usa a rede do servidor, **qualquer serviço que escute em todas as interfaces** fica alcançável pela VPN. Hoje é o painel (8090, com senha). O painel do WAHA escuta só em `127.0.0.1` e **não** é alcançável pela VPN; para ler o QR do WhatsApp, use o próprio servidor.
- A câmera e o resto da rede doméstica **não** são expostos (o servidor não anuncia sub-redes).
- Para dar acesso a outra pessoa, use o recurso de compartilhar máquina do Tailscale, em vez de passar a sua conta.

### 9.4. Manutenção e problemas

| Situação | O que fazer |
|---|---|
| Ver o estado | `docker exec camera-tailscale tailscale status` |
| Servidor sumiu da VPN | `docker logs --tail 30 camera-tailscale`; se pedir login, gere uma chave nova e repita o 9.1 |
| Não abre `camera-viewer:8090` | Confirme que a VPN está ligada no aparelho; tente o IP `100.x.x.x:8090`; confira `docker compose ps` |
| Trocar de conta ou refazer | `docker compose rm -sf tailscale`, apague os arquivos de `tailscale_state/` (alguns pertencem ao root: `sudo rm -rf tailscale_state/*`), gere uma chave nova e repita o 9.1 |
| VPN conecta (aparece no Tailscale) mas o painel não abre | O contêiner estava em modo *userspace* (sem a interface `tailscale0`). | Confira `TS_USERSPACE: "false"` no compose e `ip addr show tailscale0` (deve mostrar o IP `100.x`). |
| Contêiner reiniciando sem parar (`docker ps` mostra `Restarting`) | Falta a chave em `tailscale.env`. Pare com `docker compose rm -sf tailscale` e faça o 9.1 |
| Remover a VPN | `docker compose rm -sf tailscale` e remova a máquina em https://login.tailscale.com/admin/machines |

A pasta `tailscale_state/` guarda a identidade do servidor na VPN. Ela **não** entra no `backup.sh`: em um servidor novo, faça um login novo (ter dois servidores com a mesma identidade causa conflito).

---

## 10. Backup e restauração

O código pode ser recriado; o que **não** pode ser perdido é a configuração, os segredos e os cadastros. O `backup.sh` guarda tudo isso, inclusive as câmeras cadastradas (`cameras/`), sem as fotos de ocorrências:

```bash
./backup.sh                      # cria ./backups/camera-backup-AAAA-MM-DD_HHMM.tar.gz
./backup.sh /outro/disco         # escolhe o destino
```

O arquivo contém **senhas e a sessão do WhatsApp**: guarde em local seguro (permissão 600) e nunca publique.

**Restaurar em outro servidor:** instale o projeto (código), extraia o backup dentro da pasta e suba:

```bash
tar -xzf camera-backup-....tar.gz     # na pasta do projeto
docker compose up -d --build
```

Ajuste `CAMERA_IMAGES_DIR` e `UID_GID` no `.env` se o servidor for outro. Se a sessão do WhatsApp não for aceita no novo servidor, apague `waha_sessions/` e leia o QR de novo.

As **fotos de ocorrências** (`CAMERA_IMAGES_DIR`) ficam de fora do backup, por serem grandes e já terem limpeza automática. Copie essa pasta à parte se quiser guardá-las.

---

## 11. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `no configuration file provided: not found` | Comando `docker compose` rodado fora da pasta do projeto. | Entre na pasta, ou use `docker logs camera-analyzer` (funciona de qualquer lugar). |
| Serviço não sobe: "bind source path does not exist" | O SSD/pasta de `CAMERA_IMAGES_DIR` não está montado. | Monte o disco e rode `docker compose up -d`. É a proteção funcionando. |
| Depois de reiniciar a máquina, só o WAHA e a VPN estão no ar; painel e analyzer `Exited (127)` | O SSD não foi montado (o `restart: unless-stopped` **não** tenta de novo quando o disco falta, de propósito: evita gravar no disco errado). | Monte o disco (abra-o no gerenciador de arquivos, ou `udisksctl mount -b /dev/sdXN`), confira o caminho no `.env` e rode `docker compose up -d`. **Definitivo:** monte por `/etc/fstab` com `x-systemd.automount` (README, seção 4.1). |
| Ao iniciar, chegou "portão aberto há horas" e logo "fechado" | Versão antiga restaurava o estado salvo antes de uma queda longa e contava o tempo desligado. | Corrigido: o estado salvo só vale se tiver menos de 2 minutos; depois de uma queda, o monitor recomeça do zero. |
| Painel pede senha e nunca aceita (HTTP 429) | 10 tentativas erradas: IP bloqueado por 10 min. | Espere, ou rode `docker compose restart camera-viewer` (zera o bloqueio). |
| Esqueci a senha do painel | — | Rode `./set-password.sh` de novo. |
| Ao vivo trava ou congela por 1 a 2 s | Rede instável entre a câmera e o servidor (Wi-Fi ou repetidor): o vídeo para e chega em rajada. | O painel já compensa com `liveDelaySec`. A solução de verdade é **cabo** ou Wi-Fi melhor. Diagnóstico: `ping -c 60 -i 1 IP_DA_CAMERA`; o ideal é máximo abaixo de 10 ms, e picos de centenas de ms confirmam o problema. Baixar o stream principal da câmera para ~10 quadros/s também ajuda. |
| Aba Alertas: "WhatsApp desconectado" | Sessão do WAHA caiu ou nunca foi conectada. | Na própria aba Alertas aparece o QR code (ou o botão **Conectar WhatsApp**): leia-o no celular. Se não aparecer, abra `http://localhost:3000/dashboard` na máquina do servidor; se persistir, `docker compose restart waha`. |
| Cadastrar câmera: "não foi possível gravar cameras.json" | A pasta `cameras/` não existe ou não pertence ao usuário do contêiner (`UID_GID` do `.env`). | Rode `./setup.sh` e `docker compose up -d`. Sem a pasta o Docker nem sobe o painel (de propósito). |
| Testar conexão: "usuário ou senha incorretos" | A câmera recusou o acesso. | Confira usuário e senha no app/site da própria câmera. Algumas câmeras têm um usuário só para o RTSP/ONVIF. |
| Testar conexão: "recusou a conexão" ou "não foi possível alcançar" | IP errado, câmera desligada, em outra rede, ou RTSP desativado. | Confirme o IP da câmera (`ping IP`); a máquina do Docker precisa alcançá-lo; ative o RTSP nas configurações de rede da câmera; confira a porta (554). |
| Testar conexão: "não achou esse caminho ou canal" | Marca ou canal errado. | Escolha a marca certa, ou use **Outra marca** com o endereço RTSP do manual da câmera. |
| Câmera cadastrada mostra "aguardando o analyzer…" | O analyzer ainda está carregando os modelos, ou está parado. | Espere ~1 min; `docker logs camera-analyzer`. Câmeras com *Analisar* desmarcado nunca mostram análise (é o esperado). |
| A Grade está lenta ou com poucos quadros | Muitas câmeras, rede ou processador cheios. | A grade usa quadros pequenos (`gridWidth`, `gridFps` no `config.json`); reduza-os, ou veja uma câmera por vez. |
| Foto de pessoa com "⚠ sem rosto" | O analyzer não achou rosto (rosto pequeno, de lado, tapado, ou imagem que não é de uma pessoa). | Troque por outra foto, de frente e com boa luz. |
| Meu carro aparece como "fora da garagem" estando lá | A nota ficou abaixo do mínimo (a aba Carros mostra a nota), por luz, posição ou porta aberta. | Capture outra foto dele **naquela situação** e cadastre; ou baixe a nota mínima. |
| Dois carros se trocam | Mesmo modelo/posição. | Mais fotos de cada um; suba a nota mínima. Se os dois casarem no mesmo lugar, vale o de maior nota. |
| A aba Carros mostra o carro como "fora" e a nota é ~0,2 | O carro não foi cadastrado com fotos desta câmera, ou a zona não o cobre. | Capture e cadastre o carro (precisa de fotos); confirme que a zona cobre a vaga. |
| Chegou aviso de "carro não cadastrado" sem haver carro | Só ocorre com a opção beta ligada: um carro da rua visto pelo portão dentro da zona. | Desenhe a zona só em volta da vaga ou desligue a opção. |
| Teste de WhatsApp: erro 401 ou recusa | `alerts.wahaApiKey` diferente de `WAHA_API_KEY`. | Deixe os dois iguais e reinicie analyzer e waha. |
| A mensagem de teste "não chega" | Destino igual ao número conectado, ou número sem WhatsApp. | Use outro telefone de destino (aba Alertas). Veja o erro na aba ou em `docker logs camera-analyzer`. |
| Botões com confirmação "não fazem nada" | Alguns navegadores embutidos bloqueiam `confirm()`. | O painel usa janela própria; atualize a página com `Ctrl+Shift+R`. |
| Quase tudo sai como `pessoa` (sem nome) | Rosto pequeno ou cortado pela borda de cima da imagem (câmera alta). | Normal para esse ângulo. Aprove mais fotos em **Revisar rostos** e, se possível, reposicione a câmera. |
| Falsos "desconhecida" | Poucas fotos cadastradas da pessoa, ou rosto de perfil. | Cadastre 5+ fotos (de frente e variando luz). Suba `FACE_THRESHOLD` só se houver reconhecimentos trocados. |
| Portão sempre "aberto" ou nunca "aberto" | Limiar mal ajustado, sombras mudaram a região. | Veja a similaridade na aba Portão; adicione referências em outras condições de luz; use "Calibrar com portão aberto". |
| Alertas de "portão aberto" com o portão fechado, de manhã ou à tarde | Sol/sombra mudando a nota (não é abertura). | Já tratado (queda abrupta + referências automáticas, seção 7.4). Se persistir, veja o log (`nota baixou devagar`) e adicione uma referência manual naquela luz. |
| Alerta de portão não dispara | Falta região, referência ou canal de alerta. | A aba Portão lista o que falta em amarelo. |
| "Sem atualização do analyzer" / câmera fora | Câmera sem rede, analyzer parado, stream caiu. | `docker compose ps`, `docker logs camera-analyzer`. Quedas curtas se recuperam sozinhas (reconexão em ~30 s). |
| Erro `No module named 'lap'` no analyzer | Imagem sem a dependência do rastreador. | `docker compose build --no-cache analyzer` (o `lap` está no `requirements.txt`). |
| Fotos não aparecem nas Gravações | Câmera errada no filtro, pasta errada, ou o analyzer ainda não viu movimento. | Escolha *Todas as câmeras*; confira `CAMERA_IMAGES_DIR` e `ls CAMERA_IMAGES_DIR/<câmera>`. Passe na frente da câmera e olhe o log (`[apelido] ...`). |
| Disco enchendo | Retenção desligada ou longa. | Ajuste `retentionDays` no `config.json` (reinicie o analyzer). |

---

## 12. Limitações conhecidas e ideias futuras

- **Várias câmeras dividem o mesmo processador:** a detecção roda uma câmera por vez. Com muitas câmeras vendo movimento ao mesmo tempo, cada uma é analisada com menos frequência. Câmeras só para assistir podem ficar com *Analisar* desmarcado.
- **Rostos e pessoas são comuns às câmeras** (uma pessoa cadastrada é reconhecida em todas); portão, garagem e carros são de cada câmera.
- **Câmeras só por IP:** não há busca automática de câmeras na rede (o Docker não enxerga a rede local por inteiro). O IP vem do roteador, do aplicativo da câmera ou de um leitor de rede.
- **Câmera alta** dificulta reconhecer rostos (pequenos e cortados no topo). É a maior fonte de `pessoa` sem nome.
- **Ao vivo com atraso de ~2 s** (buffer `liveDelaySec`). Vale para o que se vê; as fotos e os alertas não dependem dele.
- **Só fotos:** não há gravação de vídeo. Clipes curtos ao redor de cada evento seriam um próximo passo.
- **Sem zonas/máscaras de movimento** (ignorar árvore, sombra, rua) nem filtro de alerta por área.
- **Miniaturas:** a aba Gravações carrega a foto original de cada ocorrência; com centenas por dia ficará pesada.
- **Um único usuário** e senha, e HTTP sem criptografia (use VPN para acesso externo).
- **Aviso se o próprio analyzer parar:** não há (o `restart: unless-stopped` religa em caso de queda). Um monitor externo (por exemplo, healthchecks.io) cobriria isso.
- **Versões não fixadas** (ultralytics, imagem do WAHA): uma atualização pode quebrar algo.
- **Óculos e outros objetos específicos** exigem um modelo treinado à parte (não feito).

---

## 13. Referência da API interna

Usada pela página; todas as rotas exigem login quando há senha. Rotas POST só aceitam JSON vindo da própria página. As rotas de portão e carros (e os POST `/api/gate/*` e `/api/cars/*`) recebem a câmera em `?camera=<id>` ou `camera` no corpo; sem ela, valem para a primeira câmera.

| Rota | Função |
|---|---|
| `GET /api/cameras` | Câmeras cadastradas (sem senha) e marcas disponíveis. |
| `POST /api/cameras/save` `{id?, nome, brand, ip, port, user, password, channel, analyze}` | Cadastra (sem `id`) ou edita. Senha vazia na edição mantém a atual. |
| `POST /api/cameras/delete` `{id}`, `POST /api/cameras/test` `{...campos da câmera}` | Remove (as fotos ficam); testa a conexão e devolve uma imagem ou o motivo da falha. |
| `GET /stream?camera=<id>`, `GET /snapshot?camera=<id>` | Câmera ao vivo (MJPEG contínuo) e um quadro reduzido (usado pela Grade). |
| `GET /api/days?camera=<id\|all>`, `GET /api/events?camera=<id\|all>&date=dd-mm-yyyy`, `GET /media/<câmera>/<dia>/<arquivo>` | Gravações: dias, ocorrências e foto. |
| `GET /api/settings`, `POST /api/settings` | Telefone que recebe os alertas e o aviso de WhatsApp desconectado (valem para todas as câmeras). |
| `GET /api/whatsapp`, `GET /api/whatsapp/qr`, `POST /api/whatsapp/start` | Estado da sessão do WhatsApp, QR code para conectar e (re)início da sessão. |
| `GET /api/disk` | Espaço livre e regra de retenção. |
| `GET /api/candidates`, `GET /cand/<pasta>/<arquivo>` | Rostos pendentes e a imagem. |
| `POST /api/candidates/approve` `{items, target}` | Copia candidatos para `faces/<target>/` e remove de `faces_candidates/`. |
| `POST /api/candidates/discard` `{items}` | Apaga candidatos. |
| `GET /api/gate?camera=<id>`, `GET /gate/latest.jpg?camera=<id>` | Configuração, estado e último quadro do portão da câmera. |
| `GET /api/people`, `POST /api/people`, `POST /api/people/delete`, `POST /api/people/delete-photo`, `GET /face/<pasta>/<arquivo>` | Cadastro de pessoas (lista, criar/editar, excluir, foto). |
| `POST /api/people/upload` | Envio de **uma foto por requisição** (corpo = bytes da imagem; cabeçalhos `X-Upload: 1`, `X-Slug`, `X-Filename`). Só aceita JPG, PNG ou WEBP de verdade (confere o conteúdo), até 10 MB. |
| `GET /api/cars?camera=<id>`, `GET /car/<câmera>/<carro ou _capturas>/<arquivo>` | Carros, ajustes, capturas pendentes e estado da garagem da câmera. |
| `POST /api/cars/config`, `/save`, `/delete`, `/delete-photo`, `/capture`, `/assign`, `/discard` | Zona e ajustes; criar/editar carro; excluir; pedir captura à câmera; atribuir uma captura a um carro; descartar captura. |
| `POST /api/gate/config` `{camera, ...}` | Salva ajustes da câmera (região, limiar, tempos, regras de alerta). Valida tudo. |
| `POST /api/gate/cmd` `{camera, cmd}` | Comandos: `add_closed`, `clear_refs`, `calibrate_open`, `test_alert`, `test_telegram`. |

---

## 14. Ambiente de referência

Onde o sistema foi desenvolvido e testado, para você comparar ao montar o seu:

- **Servidor:** Linux (Ubuntu), 12 núcleos, 15 GB de RAM, sem GPU. Docker 29 e Compose 5 (Docker instalado por snap).
- **Câmera:** Intelbras (Dahua), RTSP. O stream leve (`subtype=1`, 704×480, 15 quadros/s) alimenta o ao vivo e o principal (`subtype=0`, 1920×1080, 20 quadros/s) alimenta a análise. A câmera ficava em outra sub-rede, alcançada pelo roteador.
- **Rede da câmera:** o ping medido até a câmera teve média de ~22 a 49 ms, com picos de até 1,5 s e paradas de vídeo de 0,6 a 1,8 s (sem perda de pacotes): sinal típico de Wi-Fi/repetidor. Por isso o ao vivo usa um buffer de 2 s (`liveDelaySec`) e o analyzer reconecta em ~8 s quando o stream trava. Cabo na câmera é a correção definitiva.
- **Fotos:** disco secundário (NTFS) montado por `/etc/fstab` com `x-systemd.automount` (seção 4.1).
- **VPN:** Tailscale em contêiner (`network_mode: host`, interface `tailscale0` real); login por chave de autenticação, usada só no primeiro login.
- **Fuso do analyzer:** `America/Sao_Paulo`.
- **WhatsApp:** WAHA engine NOWEB; a sessão conectada a um número e os alertas indo para outro (veja a aba Alertas).
- **Cadastro:** dezenas de fotos de rostos em `faces/` (de 1 a 6 por pessoa) e um carro cadastrado.

---

## 15. Licença e créditos

Este projeto é distribuído sob a **GNU Affero General Public License v3.0 (AGPL-3.0)**: veja o arquivo [`LICENSE`](LICENSE). Em resumo: você pode usar, estudar, modificar e redistribuir, e quem oferecer uma versão modificada (inclusive como serviço em rede) deve disponibilizar o código-fonte sob a mesma licença.

A escolha da AGPL-3.0 não é arbitrária: o `analyzer` usa o **Ultralytics (YOLOv8)**, licenciado sob AGPL-3.0, e um projeto que o combina e é distribuído precisa ser compatível com ela.

Componentes de terceiros (cada um mantém a sua licença; confira os termos atuais nos projetos de origem):

| Componente | Uso | Licença (conforme o projeto de origem) |
|---|---|---|
| [Ultralytics YOLOv8](https://github.com/ultralytics/ultralytics) | detecção de pessoas, carros e animais | AGPL-3.0 (existe também licença comercial) |
| [OpenCV](https://opencv.org/) e [OpenCV Zoo](https://github.com/opencv/opencv_zoo) (modelos YuNet e SFace) | rostos, imagem, casamento de padrão | Apache-2.0; os modelos têm a licença indicada no OpenCV Zoo |
| [PyTorch](https://pytorch.org/) | execução do YOLO (versão só CPU) | BSD |
| [WAHA](https://waha.devlike.pro/) | envio de WhatsApp | veja os termos no site do projeto |
| [Tailscale](https://tailscale.com/) | VPN | cliente em BSD-3-Clause; o serviço tem termos próprios |
| [FFmpeg](https://ffmpeg.org/) e [Node.js](https://nodejs.org/) | vídeo ao vivo e painel | LGPL/GPL conforme a compilação; MIT |

*Intelbras*, *Dahua*, *WhatsApp*, *Telegram*, *Tailscale* e demais nomes são marcas dos seus donos. Este projeto não tem vínculo com nenhum deles.

---

## 16. Privacidade e aviso de uso

- **O sistema reconhece rostos.** Fotos de rostos e os cadastros em `faces/` são **dados pessoais biométricos** (LGPD, GDPR e leis semelhantes). Use apenas em ambiente **seu**, informe quem é filmado e identificado, não filme áreas de terceiros (rua, vizinhos) e mantenha os dados protegidos. A responsabilidade legal pelo uso é de quem instala.
- **Nunca publique** `faces/`, `faces_candidates/`, `cars/`, `gate/`, `cameras/`, `cameraImages/`, `waha_sessions/`, `tailscale_state/`, `config.json`, `.env`, `tailscale.env` nem arquivos de backup: contêm imagens de pessoas, senhas e a sessão do seu WhatsApp. O `.gitignore` já os exclui, mas confira com `git status` antes de cada commit.
- **WhatsApp não oficial.** O WAHA conecta como "aparelho vinculado" e **pode violar os termos do WhatsApp**: o número pode ser bloqueado. Use um número reserva e poucas mensagens. Use por sua conta e risco.
- **Sem garantia.** O software é fornecido como está. Alertas podem falhar ou atrasar (rede, câmera, WhatsApp), e o reconhecimento de rostos e de carros erra. **Não use como único recurso de segurança.**
- **Sem login ou HTTPS por padrão.** Rode `./set-password.sh`, não exponha a porta 8090 à internet e use a VPN (seção 9) para acesso externo.
