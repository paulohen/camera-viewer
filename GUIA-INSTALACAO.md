# Guia: instalar o Camera Viewer em outro computador

Este guia leva você do zero até o painel funcionando num computador novo, **com uma ou várias câmeras** que estejam na mesma rede dele. Siga na ordem. Cada passo diz o que fazer e como conferir se deu certo.

Para detalhes de cada recurso e solução de problemas, veja o [README](README.md).

---

## Visão geral (o que você vai fazer)

1. Escolher o computador e instalar o Docker.
2. Descobrir o IP, o usuário e a senha de cada câmera.
3. Copiar o projeto e rodar o `./setup.sh`.
4. Subir o sistema com `docker compose`.
5. Proteger o painel com senha.
6. Conectar o WhatsApp (QR code) — **novo para cada computador**.
7. Cadastrar as câmeras no painel (com um apelido para cada uma).
8. Calibrar portão, garagem e pessoas, e testar os alertas.

Tempo: cerca de 30 a 60 minutos, mais o tempo de download da primeira vez (alguns GB).

---

## 1. O computador

**Precisa de:**

- **Linux** (Ubuntu ou Debian são os mais simples). O sistema foi desenvolvido e testado em Ubuntu. Windows e Mac **não foram testados**.
- **Estar ligado o tempo todo** e ligado à mesma rede das câmeras (de preferência por cabo).
- **Processador e memória.** Medido com **uma** câmera: 12 núcleos e 15 GB de RAM, com uso de cerca de 14% de um núcleo parado e picos curtos quando há movimento. Como regra prática, comece com **4 núcleos e 8 GB de RAM** e observe. **Ainda não foi medido com várias câmeras reais** ao mesmo tempo: o analyzer divide o mesmo processador entre elas (uma detecção por vez), então com muito movimento em várias câmeras cada uma é analisada com menos frequência. Câmeras que você só quer **assistir** podem ficar com *Analisar esta câmera* desmarcado (poupa processador).
- **Disco** para as fotos: cada foto 1080p tem ~230 KB. As fotos com mais de 30 dias são apagadas sozinhas (configurável).
- **Internet** (para baixar o sistema e para o WhatsApp).
- Um **celular com WhatsApp** para ser o "remetente" dos alertas (de preferência um número **reserva**, veja o passo 6).

### Instalar o Docker

> **Não use o Docker instalado por *snap*:** ele não enxerga pastas fora do seu `$HOME` (nem `/tmp`) e dá erros estranhos de montagem. Use o instalador oficial abaixo.

No Ubuntu/Debian, num terminal:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

**Saia da sessão e entre de novo** (ou reinicie) para o grupo valer. Depois confira:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

Os três comandos têm de funcionar **sem `sudo`**. Para o Docker subir sozinho quando o computador ligar:

```bash
sudo systemctl enable docker
```

---

## 2. Descobrir os dados de cada câmera

Para **cada** câmera, anote:

| Dado | Onde achar |
|---|---|
| **IP** (ex.: `192.168.0.10`) | Na lista de aparelhos conectados do **roteador**, ou no aplicativo/site da câmera. No terminal: `sudo apt install nmap` e depois `nmap -p 554 --open 192.168.0.0/24` (troque pela faixa da sua rede; mostra quem tem a porta de vídeo 554 aberta). |
| **Usuário e senha** | Os que você definiu ao instalar a câmera (em Intelbras/Dahua o usuário costuma ser `admin`). |
| **Marca/modelo** | Na etiqueta da câmera. O painel já sabe montar o endereço de vídeo de Intelbras/Dahua, Hikvision, TP-Link Tapo e Reolink. Outras marcas: você informa o endereço RTSP do manual. |

**Dicas importantes:**

- **Fixe o IP da câmera** no roteador (reserva de DHCP). Se o IP mudar, o painel perde a câmera até você editar o IP.
- O **RTSP precisa estar ligado** na câmera (nas configurações de rede/avançado). Em algumas marcas fica ligado por padrão; em outras (Tapo, por exemplo) é preciso criar uma "conta de câmera" nas configurações avançadas do aplicativo e usar essa conta.
- O computador e as câmeras precisam se enxergar na rede. Se as câmeras estão em outra sub-rede (outro roteador/repetidor), o computador precisa conseguir alcançar o IP delas (teste com `ping IP`).
- **Teste a câmera antes**, se quiser: no VLC, **Mídia ▸ Abrir fluxo de rede** e cole `rtsp://usuario:senha@IP:554/...` (o painel também tem o botão *Testar conexão*, que faz o mesmo e mostra o motivo do erro).

Endereços RTSP que o painel monta sozinho (você não precisa digitá-los):

| Marca | Ao vivo (leve) | Análise (alta resolução) |
|---|---|---|
| Intelbras / Dahua | `/cam/realmonitor?channel=1&subtype=1` | `/cam/realmonitor?channel=1&subtype=0` |
| Hikvision | `/Streaming/Channels/102` | `/Streaming/Channels/101` |
| TP-Link Tapo | `/stream2` | `/stream1` |
| Reolink | `/h264Preview_01_sub` | `/h264Preview_01_main` |

---

## 3. Copiar o projeto e rodar o setup

Coloque o projeto dentro do seu `$HOME` (por exemplo, `~/camera-viewer`) e entre na pasta:

```bash
cd ~/camera-viewer
```

> **Não copie estes itens de outro computador** (eles são de cada instalação): `config.json`, `.env`, `cameras/`, `waha_sessions/`, `tailscale_state/`. A sessão do WhatsApp fica presa ao aparelho/servidor onde foi lida, e as chaves devem ser únicas. O `setup.sh` cria tudo novo.
> Se quiser levar para o computador novo as **pessoas cadastradas** (`faces/`), copie só essa pasta.

Rode:

```bash
./setup.sh
```

Ele:

- cria as pastas que o Docker precisa (`faces`, `cars`, `gate`, `cameras`, `waha_sessions`…);
- cria o `.env` com **chaves aleatórias** (esta é a "chave nova" do WhatsApp: `WAHA_API_KEY`; veja o passo 6) e escolhe a pasta das fotos (`cameraImages` dentro do projeto);
- cria o `config.json` e pergunta **o telefone que vai receber os alertas** (com código do país e DDD, ex.: `+5511999999999`; pode deixar em branco e pôr depois, no painel).

Ele **nunca sobrescreve** o que já existe, então pode rodar de novo.

**Fotos em outro disco (opcional):** abra o `.env` e troque `CAMERA_IMAGES_DIR` pelo caminho do disco grande (a pasta tem de existir). Se o caminho não existir o sistema **não sobe**, de propósito: evita gravar no disco errado quando um disco externo não foi montado. Disco externo: monte-o por um caminho fixo (README, seção 4.1).

---

## 4. Subir o sistema

Há dois jeitos. Escolha **um**.

**A) Imagens prontas (mais rápido, recomendado).** O painel e o analyzer são baixados já construídos do GitHub Container Registry; o WhatsApp (WAHA) também é uma imagem pronta. Não constrói nada no computador. Precisa do Docker Compose 2.24 ou mais novo (`docker compose version`).

```bash
./setup.sh --imagens     # pode rodar de novo, mesmo que já tenha rodado o ./setup.sh: só acrescenta COMPOSE_FILE ao .env
docker compose pull
docker compose up -d
```

Se o `pull` responder `denied` ou `unauthorized`, as imagens ainda estão privadas: quem publica deve torná-las públicas (GitHub ▸ perfil ▸ Packages ▸ cada imagem ▸ Package settings ▸ Change visibility ▸ Public; elas não têm segredos), ou você faz `docker login ghcr.io` com um token do GitHub com permissão `read:packages`. Para fixar uma versão, ponha `CAMERA_VIEWER_TAG=1.0.0` no `.env`.

**B) Construir no próprio computador** (não depende de registro; serve também para testar mudanças no código):

```bash
docker compose up -d --build
```

Nos dois casos, a **primeira vez demora** (baixa o PyTorch, os modelos de detecção e a imagem do WhatsApp: alguns GB). Acompanhe com:

```bash
docker compose logs -f
```

(`Ctrl+C` sai dos logs sem parar nada.) Quando terminar, confira:

```bash
docker compose ps
```

Devem aparecer `camera-viewer`, `camera-analyzer` e `camera-waha` com estado **Up**. O analyzer ainda vai dizer "nenhuma câmera para analisar": normal, você cadastra no passo 7.

---

## 5. Proteger o painel com senha

```bash
./set-password.sh
```

Escolha um usuário e uma senha (mínimo 8 caracteres). **Sem isso o painel fica aberto a qualquer aparelho da rede.** Quem entra no painel vê as câmeras, e pode cadastrar câmeras e mudar configurações.

Abra o painel no navegador de **qualquer aparelho da mesma rede**:

```
http://IP-DO-COMPUTADOR:8090
```

O IP do computador aparece com `hostname -I`. Se houver firewall (`ufw`), libere a porta 8090 **só para a rede local**, por exemplo: `sudo ufw allow from 192.168.0.0/24 to any port 8090 proto tcp` (ajuste a faixa). **Nunca** libere essa porta para a internet no roteador.

---

## 6. WhatsApp (novo em cada computador)

O envio de WhatsApp usa o **WAHA**, que roda dentro do Docker. Em cada computador novo existem **três coisas diferentes**; só a segunda exige ação sua:

| O que é | O que fazer |
|---|---|
| **A chave do WAHA** (`WAHA_API_KEY`): a "senha" entre o painel e o WAHA. É o "token novo". | **Nada.** O `setup.sh` gerou uma chave aleatória e a gravou nos **dois** lugares (`.env` e `config.json`, em `alerts.wahaApiKey`). Se algum dia quiser trocar, troque **nos dois** e rode `docker compose up -d`. |
| **A sessão do WhatsApp**: qual número **envia** os alertas. | Ler o **QR code** uma vez (abaixo). |
| **O telefone que recebe** os alertas. | Informado no `setup.sh` ou na aba **Alertas** do painel. |

### Conectar o número que vai enviar

1. No painel, abra a aba **Alertas**. Com o WhatsApp ainda desconectado, aparece o **QR code** (se aparecer o botão **Conectar WhatsApp**, clique nele e espere alguns segundos).
2. No celular que vai **enviar** os alertas: WhatsApp ▸ **Aparelhos conectados** ▸ **Conectar um aparelho** e aponte para o QR code da tela.
3. O estado na aba Alertas muda para **conectado ✓** e mostra o número que está enviando.

**Cuidados:**

- Use um **número reserva** (um chip só para isso), não o seu principal. O WAHA se conecta como "aparelho vinculado" de forma **não oficial** e o WhatsApp pode bloquear números que considere suspeitos.
- O telefone que **recebe** deve ser **diferente** do que está conectado. Enviar para o próprio número cai em "Mensagem para você mesmo", sem notificação.
- Se ninguém ler o QR em ~3 minutos a sessão para sozinha: clique em **Conectar WhatsApp** de novo.

**Servidor sem tela (acesso só por SSH)?** O QR code aparece no painel, então basta abri-lo de outro aparelho da rede. Se mesmo assim quiser o painel nativo do WAHA, que só aceita conexões do próprio servidor: no seu computador, `ssh -L 3000:localhost:3000 usuario@IP-DO-SERVIDOR` e abra `http://localhost:3000/dashboard` (usuário e senha no `.env`: `WAHA_DASHBOARD_USERNAME` e `WAHA_DASHBOARD_PASSWORD`).

### Testar

Ainda na aba **Alertas**, depois de cadastrar a primeira câmera (passo 7), clique em **Testar WhatsApp**: chega uma mensagem com foto e o apelido da câmera. Se não chegar, veja o erro na própria aba e a tabela de problemas do README (seção 11).

### Telegram como reserva (opcional)

Se o WhatsApp falhar, o Telegram assume; ele é também o único canal do aviso "WhatsApp desconectado". Para ativar, crie um bot com o **@BotFather**, pegue o **token** e o **chat_id** e coloque em `config.json` (`alerts.telegramBotToken` e `alerts.telegramChatId`). Passo a passo na seção 5.4 do README. Depois: `docker compose restart analyzer camera-viewer`.

---

## 7. Cadastrar as câmeras (aba "Câmeras")

Na instalação nova, o painel abre direto nesta aba. Para **cada câmera**:

1. **Apelido**: o nome que **você** vai ver (ex.: `Garagem`, `Portão da frente`). É só para diferenciar; pode mudar depois.
2. **Marca / modelo**: escolha a sua. Se a marca não estiver na lista, escolha **Outra marca** e informe o endereço RTSP completo do manual (`rtsp://usuario:senha@IP:554/caminho`).
3. **IP**, **porta** (554, quase sempre), **usuário**, **senha** e **canal** (1, a menos que seja um gravador com vários canais; nesse caso cadastre cada canal como uma câmera, mudando só o canal).
4. Clique em **Testar conexão**. Se tudo estiver certo, aparece **uma imagem da câmera**. Se não, o painel diz o que deu errado (senha errada, IP inalcançável, caminho errado).
5. Clique em **Salvar câmera**. A análise dela começa em alguns segundos, **sem reiniciar nada**.

Repita para cada câmera. O painel passa a ter, para cada uma:

- **uma pasta própria de detecções**: `cameraImages/<apelido>/dd-mm-yyyy/` (o nome da pasta vem do apelido na criação e **não muda** se você renomear depois);
- o seu **portão**, a sua **garagem** e os seus **carros**;
- alertas que dizem **de qual câmera** vieram.

Para **editar** (por exemplo, o IP mudou) use **Editar** no cartão da câmera; senha em branco mantém a atual. **Remover** tira a câmera do painel e para a análise, mas **não apaga as fotos já gravadas**.

### Ver as câmeras

Na aba **Ao vivo**: clique no apelido da câmera para vê-la, ou em **▦ Grade** para ver todas ao mesmo tempo (clique numa câmera da grade para ampliar; **⛶ Tela cheia** serve para um monitor de parede).

---

## 8. Configurar e testar

Estes passos têm abas com seletor de **Câmera** no topo: configure uma câmera por vez.

1. **Pessoas** (vale para todas as câmeras): cadastre cada pessoa com 5 a 10 fotos do rosto (de frente, boa luz). Com o tempo, a aba **Revisar rostos** sugere mais fotos tiradas pelas próprias câmeras.
2. **Portão** (só nas câmeras que enxergam um portão): arraste sobre a imagem para marcar a região do portão ▸ **Salvar região** ▸ com o portão **fechado**, **Adicionar referência** (repita à noite) ▸ opcionalmente, com o portão **aberto**, **Calibrar com portão aberto**.
3. **Carros** (só nas câmeras que enxergam a garagem): desenhe a garagem, capture e cadastre cada carro (README, seção 7.6).
4. **Alertas**: confira o telefone, as regras de pessoa desconhecida e de "câmera sem sinal" de cada câmera.

### Conferir que está funcionando

- [ ] **Ao vivo** mostra cada câmera (e a **Grade** mostra todas).
- [ ] Passe na frente de uma câmera: em poucos segundos aparece uma foto na aba **Gravações** (escolha a câmera, ou *Todas as câmeras*), na pasta `cameraImages/<apelido>/`.
- [ ] **Testar WhatsApp** entrega a mensagem com foto.
- [ ] Na aba **Câmeras**, cada câmera analisada mostra **● análise funcionando**.
- [ ] Reinicie o computador e confira que tudo volta sozinho (`docker compose ps`). Se as fotos estão em disco externo, ele precisa estar montado de forma fixa (README, seção 4.1).

---

## 9. Depois de instalado

| Quero… | Como |
|---|---|
| Adicionar ou trocar uma câmera | Aba **Câmeras** (nada de reiniciar). |
| Ver os logs | `docker logs --tail 50 camera-analyzer` (cada linha começa com o `[apelido]` da câmera). |
| Reiniciar | `docker compose restart analyzer camera-viewer` |
| Parar tudo | `docker compose down` (os dados ficam) |
| Atualizar o sistema | `./setup.sh`; depois `docker compose pull && docker compose up -d` (imagens prontas) ou `docker compose up -d --build` (construindo aqui) |
| Fazer backup | `./backup.sh` (guarda configuração, **senhas das câmeras**, rostos e a sessão do WhatsApp; **não** guarda as fotos). Guarde o arquivo em lugar seguro. |
| Acessar de fora de casa | VPN (Tailscale), README seção 9. **Chave nova** neste computador. Não faça redirecionamento de porta no roteador. |
| Mudar o telefone que recebe | Aba **Alertas**. |
| Trocar o número que envia | Desvincule o aparelho no WhatsApp e leia o QR de novo (aba Alertas). |

## 10. Problemas comuns

| Sintoma | O que fazer |
|---|---|
| `permission denied` ao usar o `docker` | Falta `sudo usermod -aG docker $USER` e sair/entrar na sessão (passo 1). |
| `bind source path does not exist` ao subir | Falta uma pasta: rode `./setup.sh`. Se for a das fotos, o disco não está montado ou o `CAMERA_IMAGES_DIR` do `.env` está errado. |
| Aba Câmeras: "não foi possível gravar cameras.json" | A pasta `cameras/` pertence a outro usuário. Rode `./setup.sh` e confira o `UID_GID` do `.env` (`echo "$(id -u):$(id -g)"`). |
| Testar conexão não funciona | Veja a mensagem; confira IP (`ping`), usuário/senha, RTSP ligado na câmera e a marca escolhida. |
| WhatsApp "desconectado" | Aba Alertas ▸ **Conectar WhatsApp** e leia o QR de novo. |
| Câmera com "aguardando o analyzer…" | O analyzer ainda carrega os modelos (espere 1 minuto) ou está parado: `docker logs camera-analyzer`. |
| Imagem trava | Quase sempre é a rede da câmera (Wi-Fi/repetidor): use cabo. |

Mais casos e explicações: **README, seção 11**.
