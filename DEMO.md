# Guia rápido — demonstração ao vivo

## 1. Arrancar o servidor

**No teu PC (Windows):**
Faz duplo-clique em [`start-twinflow.bat`](start-twinflow.bat) e deixa a janela aberta durante a demo.

**Em qualquer servidor com Node.js 20+:**
```
npm install
npm start
```
(o `npm start` já lê a variável `PORT` do ambiente, se o servidor definir uma).

## 2. Onde aceder

- **No mesmo PC:** http://localhost:8123
- **Noutro dispositivo na mesma rede** (telemóvel, tablet, outro PC): `http://<IP-do-servidor>:8123`
  → o IP muda sempre que o PC muda de rede Wi-Fi. Confirma antes da demo:
  `ipconfig` (Windows) → "Endereço IPv4" do adaptador Wi-Fi/Ethernet ativo.
- **Acesso público pela internet:** só funciona se fizeres deploy num serviço como o
  Render.com (ver secção "Deploying to the web" no [README](README.md)). Um endereço
  local (`localhost` ou IP da rede) nunca é acessível fora dessa rede.

## 3. Login

Conta por omissão no primeiro arranque: **admin / admin**
→ Recomendo mudar a password antes de uma demo pública (perfil → mudar password, canto superior direito).

Para mostrar os diferentes perfis (fábrica, logística, equipa de obra), cria contas antes
da demo em **👤 Users** (menu só visível para admin) — assim podes trocar de sessão em
diferentes dispositivos/separadores e mostrar o fluxo real multi-parte.

## 4. Roteiro sugerido para a demonstração

1. **Dashboard** — visão geral do portefólio (KPIs, projetos, previsão do tempo/grua, lookahead).
2. **+ New project** — cria um projeto novo (nome + morada) e carrega um IFC no mesmo passo
   (ou usa o modelo de exemplo em **IFC Model → Load sample model**).
3. **IFC Model** — mostra o visualizador 3D: clicar para selecionar/deselecionar elementos,
   filtros por tipo/piso, cores por estado (🎨 Status colors).
4. **Quantities (QTO)** — mapa de quantidades automático; seleciona elementos → cria pedido
   de produção (também podes criar diretamente a partir da seleção no modelo 3D).
5. **Production Requests** — percorre o fluxo: Draft → Submitted → Accepted → In Production
   → Ready → Sent/Transit → Delivered → Installed (troca de conta/perfil para mostrar as
   permissões por papel). Mostra também: e-mail automático à fábrica, etiquetas QR, registo
   "as built" pela fábrica, e o botão de eliminar pedido (admin).
6. **Scan** — leitura do QR de um elemento e registo do ciclo de vida (built/loaded/lifted/fixed).
   ⚠️ **Ver limitação da câmara abaixo.**
7. **Partners** — gerir fábrica, logística, equipa de obra, contactos.
8. **Configuration (⚙)** — exportar/importar dados, estado do e-mail (SMTP).

## 5. Limitações importantes a saber antes da demo

- **Câmara do telemóvel (Scan) só funciona em HTTPS ou em `localhost`.** Os browsers
  bloqueiam o acesso à câmara em `http://` normal (ex.: `http://192.168.1.171:8123`).
  Nesse caso, a app funciona à mesma — usa o campo manual "Or type the element GUID"
  na vista Scan para simular a leitura. Se precisares mesmo da câmara ao vivo, faz o
  deploy num serviço com HTTPS automático (Render.com) antes da demo.
- **Dados partilhados:** todos os dispositivos ligados ao mesmo servidor veem os mesmos
  dados em tempo real. Se quiseres começar a demo "do zero", usa **⚙ Configuration →
  Reset all data** antes — isto apaga tudo (projetos, pedidos, modelos IFC) em todos os
  dispositivos, por isso faz isso antes de as pessoas se ligarem, não durante.
- **E-mail:** por omissão está em modo de teste (`smtp-config.json` com `"test": true`) —
  os envios são simulados e aparecem no histórico do pedido, mas não chegam a caixas de
  correio reais. Para enviar e-mails verdadeiros na demo, configura credenciais SMTP reais
  (ver secção "Email to the factory" no README) antes.

## 6. Depois da demo

Se os dados criados durante a demonstração não interessam manter, usa
**⚙ Configuration → Reset all data** para limpar tudo antes da próxima sessão.
