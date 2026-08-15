# TwinFlow v1 → TwinLab (V2) — registo de alterações

Este ficheiro existe para uma coisa só: permitir levar para o TwinLab o que for feito aqui.

**Não é o CHANGELOG.** O `CHANGELOG.md` é escrito para quem *usa* o TwinFlow — diz o que
mudou e porque interessa. Este é escrito para quem vai **reimplementar** a alteração noutra
base de código: que ficheiros, que forma de dados, que invariante, o que parte se for
copiado às cegas.

**Os dois projetos são independentes.** O `serve.mjs` e o `store.js` partilham antepassados
mas os ficheiros já divergiram. Cada entrada aqui é uma **especificação para reescrever**,
nunca um patch para aplicar. Não copiar código entre repositórios por ferramenta.

Entradas mais recentes primeiro.

**O modelo de dados está desenhado em `DATA-MODEL.md`** — 18 entidades, 23 relações, tirado
do código e de registos reais. Ler antes de reimplementar qualquer coisa daqui: mostra que
só existem sete tabelas SQLite e que metade das entidades do domínio (linhas do pedido,
eventos, não conformidades, inspeções, montagem, receitas, saldos por fábrica) vive dentro
de colunas JSON. Também diz o que um diagrama ER não consegue dizer — a máquina de estados
do pedido, os três portões obrigatórios, e que um saldo é consequência do livro de
movimentos e não um valor que alguém escreve.

---

## 1.31.1 — Um aviso que sobrevive à causa é uma mentira com atraso

**O defeito, em uma frase:** o aviso de "a mostrar o último estado conhecido" era **levantado**
por duas vias e **baixado** por uma só — o evento `online` do browser, que dispara quando é o
*aparelho* a recuperar a ligação. Quando quem foi abaixo e voltou foi o **servidor** (uma
reinicialização depois de implantar), esse evento nunca dispara: o aviso ficava para sempre,
enquanto a sondagem de 60 s **já estava a trazer dados novos por baixo dele**.

**A regra que isto ensina:** quem levanta um indicador tem de saber, pelo mesmo mecanismo,
quando o baixar. Contar com um evento do ambiente (rede, visibilidade, foco) cobre o caso em
que a causa está do lado do cliente, e **só esse**.

**Como se corrigiu, e onde tem de ficar a costura:** só o módulo que fala com o servidor
sabe quando alguma coisa lá chegou; só a UI sabe o que está escrito no ecrã. Portanto o
`store.js` **reporta o facto** (`setServerReachedHandler`, mesma costura que
`setOrderConflictHandler`/`setPushRejectedHandler` já usavam) e o `app.js` decide o que fazer
com ele. Reportado em três sítios: no `fetchServerState()`, na sondagem `api/rev` (é a
batida de coração — corre haja ou não alterações, por isso é a que realmente apanha o
servidor a voltar) e no `apiPush()`, onde **uma recusa também conta**: um 403 prova que se
chegou lá.

**Duas decisões pequenas que importam:**
1. O handler decide pelo **DOM** (o aviso está visível?) e não pela variável `offlineSession`,
   porque só uma das duas vias a define. Decidir pela variável deixava o outro caso por
   corrigir — foi o primeiro erro que cometi nesta correção.
2. **Não re-renderiza.** Todas as vias que reportam ou já aplicaram o estado novo (e
   re-renderizaram pelo `onRemoteChange`) ou verificaram que nada mudou. Re-renderizar aqui
   seria repintar a aplicação inteira de minuto a minuto para nada.

**O que fica por decidir:** o aviso continua a **não subir** quando é o servidor a cair com o
aparelho ligado — uma sondagem falhada é um sinal fraco (basta um pedido perdido em obra) e
levantá-lo por causa disso ensinaria a ignorá-lo. Se o V2 o quiser, exigir N falhas seguidas,
não uma.

## 1.31.0 — 4D: reconstruir o passado a partir de dois rastos com resoluções diferentes

**Não há dados novos.** O 4D não escreve nada: reconstrói o estado de cada elemento numa data
a partir do que já existia. Se o V2 guardar o histórico de outra maneira, é **esta**
reconstrução que muda, não o resto.

**Os dois rastos, e porque não são intermutáveis:**
1. `order.events` — uma entrada por transição, escrita por `advanceOrder()` com a forma
   `${STATUSES[de].label} → ${STATUSES[para].label}`. Move **todos** os elementos do pedido
   ao mesmo tempo.
2. `order.tracking[globalId]` — as leituras por elemento (`built`, `loaded`, `lifted`,
   `fixed`, `diaphragms`, `groutPrep`, `grouted`). É o **único** sítio onde dois elementos do
   mesmo pedido se separam.

**A regra que faz o resultado ficar certo: o estado em T é o MAIS AVANÇADO dos dois, não o
mais recente.** Se for o mais recente, um elemento já fixado **recua** para "entregue" no dia
em que o pedido inteiro lá chega — e a animação anda para trás à frente de quem a vê. Em
código: percorrer os passos do pedido até T (o último ganha, porque `rejeitado → rascunho` é
um recuo legítimo do pedido), e depois deixar as leituras subirem esse valor por
`STATUS_ORDER.indexOf`, nunca baixá-lo.

**O mapeamento leitura → estado** (é uma decisão, não um facto do domínio): `built`→`ready`,
`loaded`→`transit`, `lifted`→`delivered`, `fixed` e tudo depois → `installed`. Ou seja: içado
= está em obra; fixado = instalado.

**Ler o rasto obriga a ler texto em inglês.** As transições guardam a *etiqueta* do estado,
não a chave, e as etiquetas são escritas no momento e nunca traduzidas. O mapa inverso
(`STATUS_BY_LABEL`) já existia no v1 para os gráficos de tempo de ciclo. **No V2, guardar a
chave do estado no evento** e poupar isto — é a única razão pela qual as etiquetas em
`STATUSES` não se podem reescrever no v1 sem partir o histórico.

**Invalidação da cache sem relógio:** a linha do tempo é reconstruída quando muda a
assinatura `projectId:nºpedidos:totalDeEventos`. Os eventos só crescem (toda a mutação
empurra um), por isso a contagem funciona como número de versão — o mesmo raciocínio que a
fila de envios offline já usava para detetar um pedido desatualizado. Sem isto, reconstruía-se
a cada passo da reprodução (duas vezes por segundo).

**Eixo do tempo adaptativo:** mais de 3 dias → um passo por dia; menos → um passo por hora
(dados de teste feitos todos na mesma tarde seriam um único passo). O ritmo do ▶ é
`20000 / nºpassos` limitado a [80, 700] ms: uma obra de seis meses e uma de uma semana levam
ambas ~20 s de ponta a ponta. Um intervalo fixo torna uma das duas impossível de ver.

**Uma só função de visibilidade.** Os filtros de categoria/piso e o "ocultar o que ainda não
foi pedido" **têm de partilhar o mesmo predicado** (`applyModelVisibility()`). Eram duas
chamadas independentes a `applyVisibility()` e a segunda desfazia a primeira em silêncio.
O mapa de quantidades lê só o filtro (`modelFilter`), **nunca** a data — as quantidades do
modelo não podem depender de onde está o cursor do tempo.

**Legenda estável.** Enquanto corre, a legenda lista todos os estados que o projeto **alguma
vez** atinge, com contagem (incluindo zeros). Reconstruí-la a partir do que está pintado
naquele instante faz os itens aparecerem e desaparecerem e a linha inteira desloca-se
lateralmente a cada passo.

**Ficheiros tocados no v1:** `js/app.js` (secção "4D", `applyStatusColors` com duas fontes,
`applyModelVisibility` extraída), `index.html` (barra), `css/styles.css`, `js/lang/*.js`
(10 chaves `fourd.*`).

**Armadilhas encontradas:** (a) `DAY_MS` e `STATUS_BY_LABEL` já existiam mais abaixo no
mesmo módulo — em `app.js`, que tem 5 000 linhas, verificar sempre antes de declarar; (b) o
cronómetro do navegador é **estrangulado a ~1 tick/segundo em separadores em segundo plano**,
o que na medição parece uma reprodução lenta e não é.

**Por fazer:** os elementos aparecem/desaparecem de repente; um esbatimento de um passo
tornaria a leitura mais suave. E não há forma de exportar a sequência como vídeo — foi
pensado, não pedido.

## 1.30.0 — Ligar a expedição a um serviço externo sem lhe entregar o controlo

**A ordem das operações é a decisão.** Os movimentos são escritos e confirmados **antes** de
se falar com a AT, e uma falha da AT **não** transforma a chamada inteira em erro: devolve-se
`{ok:true, at:{ok:false, error}}`. O stock moveu-se de facto; recusar admiti-lo porque um
serviço fiscal esteve em baixo deixaria o armazém e a prateleira a discordar. **Numa
integração externa, decidir o que acontece quando o outro lado falha vale mais do que o
caminho feliz.**

**O número é gasto uma vez e reutilizado na repetição.** O documento foi emitido com aquele
número; repetir comunica o MESMO documento. Tirar número novo a cada tentativa queimaria um
por falha e deixaria dois números a descrever uma carga. Pelo mesmo motivo o **tipo** não se
re-escolhe: um GT numerado `GD 2026/1` é um documento a contradizer-se.

**O travão tem de sobreviver ao que se lhe acrescenta para o testar.** Foi preciso um
`endpointOverride` para apontar a um serviço de simulação — e ele é **ignorado em produção**.
Um gancho de teste capaz de redirecionar submissões fiscais reais não é um gancho de teste,
é um buraco.

**Como se testa um cliente cujo serviço não se pode contactar: faz-se o serviço.** Um servidor
de simulação que decifra o cabeçalho WS-Security com a chave privada — exatamente como a AT
faria — regista o que recebeu e responde com um Código AT. Isso cobre o fluxo todo:
credenciais em falta, sucesso, recusa, repetição. A recusa é comandada por um **ficheiro de
bandeira** e não pelo conteúdo do pedido, senão a repetição do mesmo documento seria sempre
recusada e o caso que interessa ficava por testar.

**Dois defeitos reais apanhados por este teste, ambos meus:**

1. **O leitor de etiquetas XML casava com nomes mais longos.** `<(?:\w+:)?Username[^>]*>`
   casa com `<wss:UsernameToken>` porque o `[^>]*` engole o resto do nome — o valor voltava
   com a etiqueta de abertura colada à frente. Falta o lookahead `(?=[\s/>])`. Estava tanto
   no `parseResponse` real como no simulador.
2. **BOM no ficheiro de configuração.** O `Out-File` do PowerShell e qualquer editor de
   Windows escrevem um BOM, e o `JSON.parse` recusa-o — o sintoma é «a AT não está
   configurada» com o ficheiro à frente, aparentemente correto. Passou a ser removido à
   leitura. **Uma hora perdida por um carácter invisível é o preço de não o prever.**

---

## 1.29.1 — WS-Security da AT: o que se prova sem o serviço, e o que fica marcado como palpite

**O esquema, do manual da AT (secção H):** `K_S` é uma chave AES de 128 bits gerada a cada
pedido e que **não pode repetir-se**; `Nonce` = Base64(RSA(`K_S`, chave pública da AT));
`Password` = Base64(AES-ECB-PKCS5(senha do Portal, `K_S`)); `Created` = o mesmo sobre um
timestamp UTC ISO-8601. O serviço valida a data, portanto o relógio tem de estar certo.

**Duas armadilhas de nomenclatura:** o «PKCS5Padding» do Java sobre AES é PKCS#7 com bloco
de 16 — igual ao que o Node faz por omissão, nome diferente. E o padding do RSA: o manual
diz só «RSA», mas é **PKCS#1 v1.5**; o Node usa OAEP por omissão e o serviço rejeita.
**Está marcado no código como suposição, não como citação** — é a única do módulo.

**O que NÃO se conseguiu obter:** o WSDL saiu do endereço que o manual indica (404). Logo o
elemento que embrulha o pedido, o seu namespace e o nome do campo da resposta que traz o
Código AT **não são verificáveis**. Em vez de os enterrar no código, ficam num objeto
`AT_CONTRACT` sobreponível pelo ficheiro de configuração — confirmar contra o WSDL passa a
ser editar um JSON. **Isolar o que não se sabe é melhor do que adivinhar bem.**

**Ordem dos elementos importa.** Uma `sequence` de XSD recusa os elementos certos na ordem
errada, e o erro que devolve é genérico. A ordem seguida é a numeração do manual (1.1 a
1.18) e há um teste que a verifica, porque é o tipo de coisa que se estraga numa
reorganização inocente.

**Como se testa um cliente de um serviço a que não se pode ligar:** faz-se o papel do
servidor. Gera-se um par RSA, dá-se a metade pública ao módulo e usa-se a privada para
desfazer o que ele produziu. Isso prova a cifra ponta a ponta. Depois: 200 pedidos → 200
chaves distintas (a não-repetição é requisito explícito), a senha em claro não aparece no
cabeçalho, os caracteres XML são escapados, os campos opcionais vazios são **omitidos** em
vez de enviados em branco, e uma resposta de erro ou um SOAP Fault **não** são lidos como
sucesso. Fica de fora do alcance de qualquer teste local: os nomes do contrato e o serviço
responder.

---

## 1.29.0 — Não partir dados por adivinhação, e numerar sem repetir

**Morada em partes, sem migração automática.** A AT quer `AddressDetail`, `City`,
`PostalCode` e `Country` separados, obrigatórios no remetente e no local de carga. O
TwinFlow tinha um bloco de texto livre. **Não se partiu por regex.** Separar «Rua X, 210
3030-775 Coimbra» funciona nos exemplos e falha no vigésimo caso real — e num documento
legal um endereço mal partido é pior do que um campo vazio que alguém preenche. O texto
antigo fica como a linha de morada; os outros três pedem-se.

**Regra geral:** migrar dados por inferência só quando o erro é visível e reversível. Aqui
não é nem uma coisa nem outra.

**Onde se avisa importa.** A falta dos campos aparece no documento de acompanhamento, que é
onde alguém está a olhar antes de a mercadoria sair — não no momento da submissão, quando já
custa. Extensão da lista `missing` que já existia.

**Numeração: as duas propriedades puxam em sentidos opostos.** Sem falhas e sem repetições.

- **Sem falhas** é a razão para NÃO numerar no momento do envio. A maior parte do material
  sai sem nunca ser documento comunicado; numerar tudo queimaria números. O contador só
  avança quando um documento é mesmo emitido — `nextDocumentNumber()` consome, `docPeek()`
  espreita sem consumir.
- **Sem repetições** é a razão para os contadores serem tratados como os marcadores de
  migração no `PUT /api/state`: um export importado traz os SEUS contadores e aceitá-los tal
  e qual entrega um número duas vezes. **Junta-se pelo máximo.** Quando as duas propriedades
  colidem, escolhe-se saltar um número — repetir num documento legal não tem emenda.
- Mudar para uma série que já emitiu documentos é recusado: recomeçava a numeração a meio
  dela.

**Chave do contador é `tipo|série`**, não só o tipo — mudar de série recomeça em 1, que é o
comportamento correto e sai de graça da forma da chave.

---

## 1.28.0 — Um segredo que TEM de ser recuperável, e como se guarda mesmo assim

**O caso que quebra a regra habitual.** Palavras-passe guardam-se com hash e nunca se
recuperam. Esta não pode: o esquema WS-Security da AT exige a senha **em claro** no momento
do pedido, para a cifrar com a chave AES daquele pedido. Não há arranjo em que a submissão
seja automática e a senha seja irrecuperável — é inerente ao que a AT pede, não um atalho.

**Então guarda-se cifrada, com a chave fora da base de dados.** AES-256-GCM, chave em
`TWINFLOW_AT_KEY`, fora da raiz web. As consequências dizem-se em voz alta em vez de se
esconderem: quem tiver só a base de dados não lê nada; quem tiver a base **e** a chave lê.

**Sem chave configurada, RECUSA.** É a decisão que interessa. A alternativa preguiçosa —
guardar em claro quando não há chave — dá um sistema que parece funcionar e que só se
descobre estar errado quando já não tem remédio. Erro explícito, com o nome da variável.

**As credenciais são da CONTA, não da instalação, e isso vem do domínio.** O manual da AT
diz que o Sujeito Passivo responde pelo conteúdo da mensagem porque ela sai com as suas
credenciais, e que estas «só podem ser conhecidas pelo Sujeito Passivo». Logo: cada pessoa
mete as suas, e **não existe ramo de administrador** no endpoint. Um administrador vê o
booleano `canCommunicateAt` de cada conta e mais nada — se outra pessoa pudesse escrever
aquela senha, a responsabilidade deixava de ser atribuível.

**O que sai para o cliente é um booleano, nunca o segredo.** O `publicUser` devolve o
`atUsername` (é um identificador, `NIF/subutilizador`) e `canCommunicateAt`. O blob cifrado
não sai em resposta nenhuma. **Isto testa-se procurando o segredo no texto cru de todas as
respostas** — `/me`, `/state`, `/users` e a própria gravação — e não lendo o código.

**Configuração da ligação separada das credenciais.** Endereço, ambiente e certificados
ficam num ficheiro fora da raiz web (`TWINFLOW_AT_CONFIG`), porque incluem caminhos para
uma chave privada e não são coisa para um formulário. **O ambiente tem travão invertido:**
só a string exata `production` aponta ao serviço real; tudo o resto é testes. Comunicar um
movimento de teste ao serviço real cria um documento declarado a sério, portanto o default
nunca pode ser esse.

---

## 1.27.1 — Três defeitos silenciosos, e o que os une

**Um valor de retorno que não distingue os casos obriga o chamador a inventar.** O `apiPush`
devolve `null` tanto para rede morta como para recusa do servidor (a diferença fica em
`lastPushError`, que o `createOrder` nunca lia). Resultado: **toda a recusa era tratada como
offline** — código local inventado, pedido na lista, «criado» no ecrã, e o
`applyServerState` a apagá-lo na sincronização seguinte. **Regra: quando duas falhas exigem
respostas opostas, o valor de retorno tem de as separar** — aqui `{ok, order, queued, error}`.

**Uma fila de reposição só serve a operação que foi desenhada para repor.** A fila existente
repõe **PUTs**; uma criação por lá dá «Order not found» para sempre, porque o id nunca
existiu no servidor. Foi preciso uma **segunda fila** (`pendingNewOrders`), replicada como
POST e **escoada ANTES** da de PUTs — uma alteração a um pedido que ainda não existe falha
por definição. É um array e não um mapa: as criações repõem-se pela ordem em que foram
feitas, para os números saírem na sequência certa.

**Quem substitui a lista tem de saber o que ainda não está no servidor.** O
`applyServerState` fazia `state.orders = server.orders`. Com criações em fila isso apaga-as
do ecrã. Passou a juntar as que estão em fila e o servidor ainda não conhece — **o servidor
ganha sempre** que já as tenha.

**Um valor por omissão do leitor não é uma afirmação da fonte.** O `readQty` devolvia
`unit: 'un'` para uma célula numérica normal, para uma célula vazia e para uma ilegível — e o
importador escrevia isso por cima de uma unidade curada. Nasceu `unitStated`, verdadeiro só
quando a célula **nomeou** a unidade. **Regra geral: um parser tem de distinguir «a fonte
disse X» de «a fonte não disse nada e eu assumi X»**, senão quem consome não consegue
decidir. Vale para o `type`: `mapType` devolve `''` para famílias fora da tabela, portanto o
importador **preenche mas nunca substitui**.

**Marcadores de migração descrevem a INSTALAÇÃO, não os dados.** O `PUT /api/state`
reconstruía a partir do `defaultAppState()`, que não os tem, e limpava os cinco. O perigoso é
o `pdScopedAt`: no reinício seguinte o `scopeExistingProjectDirectors` volta a dar todos os
projetos a um diretor que tinha sido restringido — exatamente a invariante que o comentário
dele promete. **Separar por natureza:** os marcadores de *privilégio/portão* (`pdScopedAt`,
`sdWaivedAt`, `resetAt`) **preservam-se**; os de *forma dos dados* (`descMergedAt`,
`typesMappedAt`) limpam-se e as migrações correm **ali mesmo**, porque a importação pode
trazer um export antigo e essas são idempotentes. Antes ficavam a meio até alguém reiniciar,
e uma importação de folha nessa janela duplicava o armazém.

**O que os três têm em comum:** nenhum dá erro. O pedido desaparece, o descritor volta a
vazio, o diretor recupera acessos — tudo sem uma linha no log. **Um defeito que não grita é
mais caro do que um que rebenta**, e é por isso que os três valeram mais do que a maior parte
das funcionalidades da mesma semana.

---

## 1.27.0 — Escrever PDF à mão, e a armadilha de codificar duas vezes

**Porque não uma biblioteca.** O alojamento não instala dependências e nada é compilado:
tudo o que venha de fora é vendorizado à mão e viaja no pacote e no telemóvel de cada
pessoa. Estes documentos são um cabeçalho, pares etiqueta/valor e uma tabela — ~230 linhas
contra ~350 KB de terceiros. Mesmo critério que produziu o leitor de `.xlsx` sem
dependências. **O limite está escrito no topo do ficheiro**: sem imagens, sem fontes
embebidas, sem quebra de linha dentro de célula. No dia em que um documento precisar disso,
a resposta é uma biblioteca, não engordar este ficheiro.

**Base-14 + WinAnsiEncoding = zero fontes embebidas.** Helvetica e Helvetica-Bold existem em
qualquer leitor. O WinAnsi cobre os acentos portugueses e o `Ø` (0xD8), que é o alfabeto todo
que esta aplicação escreve. O que está fora mapeia-se onde há equivalente óbvio (travessões,
aspas curvas) e substitui-se no resto — **um byte corrompido em silêncio num documento
impresso é pior do que um `?` visível**.

**A armadilha que custou o defeito: codificar duas vezes.** O `pdfString()` já devolve os
bytes WinAnsi transportados como caracteres — um travessão passa a ser o carácter 0x97. O
montador do ficheiro voltava a aplicar a conversão, via 0x97 como ranhura de controlo
inválida e trocava por `?`. **Todos os travessões de todos os documentos saíam como pontos
de interrogação.** Regra: **codificar UMA vez, na fronteira**; a partir daí os caracteres
*são* os bytes e o encoder final é `charCodeAt(i) & 0xFF`.

**O `xref` é o que decide se o ficheiro abre.** São deslocamentos em BYTES para cada objeto,
com entradas de 20 bytes de largura fixa, e a entrada 0 é a cabeça livre — **a numeração dos
objetos começa na entrada 1**. Acumular comprimentos em bytes, nunca em caracteres da string.

**Como se valida sem olhar.** Um leitor de PDF não é fácil de conduzir num teste, e uma
captura de ecrã do visualizador do Chrome não é fiável. O que se verifica em código são as
invariantes do próprio formato: cada deslocamento do `xref` aterra exatamente em `N 0 obj`,
o `/Length` do stream bate com os bytes reais, o `startxref` aponta para `xref`, e os bytes
acentuados sobrevivem. Doze asserções, decisivas. **Nota:** a primeira versão do validador
tinha um erro de um — lia a entrada livre como objeto 1 — e acusou o ficheiro. Quando o
verificador e o alvo discordam, confirmar qual dos dois está errado antes de mexer no alvo.

**Onde encaixa no produto:** substituiu `window.print()` nos dois documentos. Um ficheiro
anexa-se e arquiva-se; no telemóvel «imprimir» não vai a lado nenhum e descarregar abre a
partilha. O `js/pdf.js` entrou no shell do service worker — a guia é precisamente o
documento de que se precisa numa obra sem rede.

---

## 1.26.0 — Encomendas com linhas: o estado é derivado, e a receção é um facto da linha

**O erro de origem, que é o que interessa levar.** A encomenda foi modelada como
`{componentId, qty, status}` — uma referência por encomenda — porque foi assim que o ecrã
foi desenhado. **Nenhum sistema de compras funciona assim**, e o buraco não é «faltam
linhas»: é que **entregar deixa de poder ser registado** quando o fornecedor traz parte.
Não existia estado para «faltam duas referências». Lição: num domínio com prática
estabelecida (compras, stock, guias), o modelo copia-se do domínio, não do ecrã.

**Estado DERIVADO, nunca guardado como verdade.** `poStatus(po)` lê as linhas:
`delivered` se todas completas, `partial` se alguma recebeu algo, senão `invoiced`/`awarded`
conforme exista `invoicedAt`. Guardar `status` **e** linhas são dois registos do mesmo facto,
e dois registos de um facto divergem — o cabeçalho diria «entregue» com uma linha a dever 40.
O campo `status` continua a existir no objeto, mas é **reescrito pelo servidor a cada
mutação**; ninguém o aceita do cliente.

**Separar os factos por nível.** `invoicedAt` é da encomenda (a fatura é uma só);
receber é **da linha**. Misturar os dois foi o erro original. `/advance` ficou só com a
fatura; nasceu `/receive` com `{id, lineId, qty}`, e `qty` em branco significa «tudo o que
falta» — o caso comum continua a ser um clique.

**Receber a mais é recusado, não absorvido.** Se chegou mais do que o encomendado, isso é
outro ato (entrada em armazém ou acerto). Absorver faria a encomenda ler-se como se tivesse
estado certa desde o início, e o histórico deixaria de mostrar o desvio.

**A guarda de eliminação mudou de teste.** Era `status === 'delivered'`; uma encomenda
**parcial** passava nesse teste e podia ser apagada, deixando movimentos de armazém a apontar
para uma encomenda inexistente. Passou a ser «alguma linha já recebeu» —
**quando um registo ganha estados intermédios, todas as guardas escritas contra o estado
final têm de ser revistas**, não só a que falhou.

**Migração sem marcador, de propósito.** `migrateProcurementLines()` converte só o que ainda
tem `componentId` e não tem `lines`, logo é idempotente e não precisa de `meta`. Os marcadores
são perdidos por um import de estado completo (defeito conhecido do `PUT /api/state`) — uma
migração segura de repetir simplesmente não se importa. **O caso que obriga a pensar:** uma
encomenda que estava `delivered` tem de nascer com `qtyReceived = qty`, senão a migração
oferece receber bens que já estão na prateleira e duplica o stock.

**A coluna de índice ficou órfã.** `procurement.component_id` no SQLite era o id da única
referência. Com linhas não há um; escolher a primeira seria uma mentira em que uma consulta
futura acreditaria. Passou a gravar vazio, com o comentário a dizer porquê.

**O rascunho tem de viver fora do render.** A folha redesenha-se a cada linha adicionada ou
referência criada; se o estado vivesse no DOM, cada redesenho apagaria o que já lá estava.
`poDraft` fica em módulo, o `readBack()` corre antes de cada redesenho, e criar uma referência
a meio devolve o controlo por callback (`openComponentModal(null, onCreated)`) em vez de
fechar tudo.

---

## 1.25.0 — Inserir um carácter no cursor: as duas armadilhas

**O problema real:** um botão que escreve num campo de texto perde o cursor no momento em que
é premido, porque premir um botão **rouba o foco**. Quando o `click` corre, o
`selectionStart` do input já não é o que era e o carácter aterra na posição 0.

**Armadilha 1 — `mousedown` + `preventDefault()`.** É isto que impede o botão de receber
foco; o input mantém o cursor e o `click` ainda dispara. Em telemóvel tem o efeito adicional
de **não fechar o teclado**. Sem isto, nada do resto funciona.

**Armadilha 2, e esta custou uma medição a descobrir — NÃO usar o evento `focus` para saber
onde o utilizador estava.** A primeira versão guardava o campo num listener de `focus`. Falha:
**um listener de `focus` não dispara enquanto o documento não tem foco** (janela em segundo
plano), mas o `document.activeElement` é actualizado na mesma. Resultado: escrevia sempre no
primeiro campo. **Regra: não replicar em estado próprio aquilo que o DOM já sabe** — ler o
`activeElement` no momento do `mousedown`, que é quando ainda é verdade.

**Forma final:** lista branca de ids de campos onde o símbolo faz sentido; `remember()` em
`touchstart` e `mousedown`; no `click`, usa o `activeElement` se for um campo válido, senão o
último memorizado. Depois de inserir: repor o cursor com `setSelectionRange(start+1)` e
**disparar `input`** — há um verificador de duplicados a ouvir esse evento, e um símbolo
inserido assim tem de contar como escrita.

**Como se testa sem interface:** manipular `value` + `setSelectionRange` e disparar
`mousedown`/`click` sintéticos, cobrindo cursor a meio, cursor no fim, selecção substituída,
campo vazio, e foco num `<select>` (o caso de recuo). Cinco asserções, sem clicar em nada.

---

## 1.24.2 — Num visualizador que orbita, a luz tem de vir de mais do que um sítio

**O defeito não era falta de força, era falta de direções.** Uma `DirectionalLight` a 1.4 e um
`HemisphereLight` com chão `0x223` (quase preto): tudo o que apontasse para longe da key
recebia só o termo ambiente, que era ~0. Faces inferiores — soffits, barrigas de vigas —
liam-se como buracos.

**Porque não subir a key:** as cores aqui **significam** (estado do pedido, via
`colorByStatus`). Mais força satura, e duas cores saturadas aproximam-se; a informação
perde-se antes de o ecrã parecer bem iluminado. A resposta é **espalhar por direções**:
key + fill oposto fraco + bounce de baixo + headlight na câmara.

**O headlight é o que interessa para um visualizador**, e é o detalhe fácil de falhar: tem de
ser `camera.add(luz)` **e** `scene.add(camera)` — uma luz filha da câmara não é renderizada se
a câmara não estiver no grafo da cena. Sem ele, o lado oposto ao key está sempre escuro,
qualquer que seja a órbita; com ele, o que está virado para o utilizador está sempre visível.

**Como se mede isto sem adivinhar** (vale para qualquer mudança de aparência): render dos dois
regimes lado a lado com a mesma geometria e a mesma câmara, `preserveDrawingBuffer: true`,
`drawImage` para um canvas 2D e `getImageData` numa mancha de 7×7 (uma mancha, não um pixel —
o antialiasing decide um pixel sozinho). Compara-se **luminância**. Aqui: soffit 0,8 → 57,8;
superfícies já iluminadas +9 a +12%; máximo 135 de 255, portanto sem queimados; verde/vermelho
mantiveram o rácio (1,48 → 1,45). **Um número por afirmação, em vez de «parece melhor».**

**O que continua por fazer e é maior do que isto:** a tesselação. O `OpenModel` é chamado sem
opções, portanto o web-ifc usa `CIRCLE_SEGMENTS: 12` — nenhuma iluminação corrige geometria
já facetada. E cada geometria colocada é uma `Mesh` própria, o que limita o orçamento para
sombras e oclusão ambiente.

---

## 1.24.1 — Um documento derivado herda TODAS as regras da fonte, não algumas

**O defeito.** A guia é reconstruída a partir do livro de movimentos («uma expedição É o
conjunto de movimentos que partilham um carimbo e um destino»), e a reconstrução filtrava por
`type`, `ts` e `factoryId` — **mas não por `reversedBy`**. A tabela do livro já riscava as
linhas estornadas, portanto a informação existia e o derivado ignorava-a.

**A regra a levar:** quando um documento se define como «uma vista sobre estes registos»,
tem de herdar **todos** os predicados que tornam um registo válido, não só os que o
identificam. `ts`+`factoryId` respondem «que expedição é esta»; `!reversedBy` responde «isto
ainda conta». Confundir identidade com validade é o erro.

**A parte que interessa mesmo:** a mesma consulta existia **duas vezes** — no cliente para o
ecrã e no servidor para o corpo do e-mail. Foi uma escolha deliberada da 1.22.0 (o servidor
compõe para que o destinatário não possa vir do cliente), e o custo assumido nessa altura foi
«podem divergir na apresentação, nunca nos factos». Este defeito mostra o outro custo, que
não estava escrito: **uma correção num lado deixa o outro errado**, e o lado esquecido era o
que sai da empresa. No V2, se o servidor compõe o documento, a consulta que o define
existe **uma vez** — e o cliente pré-visualiza o que o servidor devolve, nunca a sua própria
reconstrução paralela.

**Caso limite que aparece de graça:** filtrar pode esvaziar o conjunto. Uma carga estornada
por inteiro tem de dar uma mensagem, não um documento vazio nem um botão que não faz nada.

---

## 1.24.0 — Quatro portas, e o padrão comum: o que se limita não é o que se devia limitar

**Uma marca só é uma marca até alguém a ler.** `mustChangePassword` era devolvida pelo
`publicUser()` e consumida por **uma linha de cliente** que desenhava um aviso fechável.
Nenhuma rota do servidor a consultava, portanto a informação «esta credencial é a de origem»
era passada ao autor da chamada e nunca usada como porta. **Regra:** um estado que descreve
uma conta como não confiável tem de ser aplicado no sítio onde a confiança é gasta — a porta
de autenticação — e não onde é apenas mostrada.

A forma no v1: logo a seguir ao `if (!user)`, recusar tudo menos a saída. `/api/me` e
`/api/logout` ficam **acima** dessa linha (o cliente tem de poder saber quem é e sair), e
`/api/password` é a única exceção abaixo. No cliente, o arranque devolve cedo e mostra só o
modal — pintar a aplicação por trás de uma parede de 403 é pior do que não a pintar. A saída
é `location.reload()`, não continuar em contexto: essa sessão nunca chegou a carregar estado.

**Um limite de emissor não é um limite de destinatário.** O `/api/send-email` tinha perfil,
limite horário e guarda de injeção de cabeçalho — tudo sobre **quem** envia e **como**. Nada
sobre **para onde**. Com SPF/DKIM válidos do domínio real, isso é um relé assinado. **Regra:**
num endpoint que envia para fora, o destinatário sai de um conjunto que a aplicação
administra (fichas de entidades + contas), nunca do corpo do pedido. Comparar em minúsculas.
Isto só é uma fronteira porque escrever essas fichas é, por sua vez, restrito e registado —
uma lista branca que qualquer pessoa possa estender não é uma lista branca.

**Um `id` bem conhecido é uma superfície.** O upsert de entidades identifica por `id`, e os
ids sementeados (`p-gc`, `p-fab`, …) são públicos e estáveis. Quem pudesse escrever entidades
podia **endereçar** a ficha do remetente ou do destino em vez de criar a sua. **Regra:**
separar «manter os dados de um registo» de «mudar o que o registo é». O primeiro fica com
quem gere fornecedores; o segundo (o `type`, e qualquer escrita numa ficha de tipo `admin`)
sobe a administrador. Validar também a **forma** do id — nada fora de `[A-Za-z0-9_-]{1,60}`
foi alguma vez emitido pelo cliente.

**Registar a mudança, não a existência.** `hasEmail: true` era verdade antes e depois de um
desvio de endereço. Um registo de auditoria sobre um campo que encaminha alguma coisa tem de
guardar `{from, to}`. Vale para qualquer campo que seja um endereço, um destino ou uma rota.

**A máscara tem de estar em todos os ramos do mesmo endpoint.** O `GET /api/state` mascarava
dentro de `if (isProjectScoped(role))`; `quality`/`logistics` caíam no `else` com o estado
cru. O `stockScope()` segue a **ligação**, não o perfil — mas o ramo que não é por projeto
nunca lhe chamava. **É a mesma família do defeito da 1.21.1** (a máscara existia num sítio e
faltava noutros): quando uma regra é «segue a ligação», ela não pode viver dentro de um `if`
sobre o perfil. No V2: uma única função de saída que **todos** os ramos atravessam.

---

## 1.23.2 (1/2) — Um PUT que substitui tudo só está guardado contra metade

**O padrão, que é o que interessa levar.** `PUT /api/orders/<id>` é uma substituição total
com uma única verificação de acesso (ao projeto). Todas as outras guardas do handler foram
escritas a pensar em **avançar**: estado desconhecido, perfil sem direito à transição,
contagem de NCs validadas a subir. **Apagar nunca foi verificado, porque só os aumentos
eram.** Uma conta `factory` do projeto — ou qualquer `quality`/`logistics`, que acedem a
tudo — regravava com `nonConformities: []` e `events` aparados, e o achado e o rasto dele
iam-se juntos. O `orderRev` não protege: o cliente lê a versão certa e devolve-a.

**Regra para reimplementar:** num endpoint de substituição total, listar os campos que são
**append-only** e tratá-los à parte, no servidor, antes de qualquer outra guarda. No v1 são
três: `events`, `nonConformities`, `inspections`.

**Junção, não recusa — e porquê.** A tentação é responder 409 quando a lista recebida é mais
curta. Parte o caminho offline: um dispositivo a repetir leituras feitas sem rede traz, por
definição, uma lista mais antiga. A forma correta é: o guardado é a base, o que vem a mais é
acrescentado, o que vem a menos é ignorado.

- `events` e `inspections` — comparação por `(ts, actor, action)` e `(ts, actor, gate)`. Não
  há id nestas entradas; no V2 dá-se-lhes um id na escrita e isto passa a ser trivial.
- `nonConformities` têm id e um estado que muda legitimamente (aberta → reparada →
  validada). Junta-se por id, deixando o estado passar mas repondo `id`, `ts` e `actor` do
  registo guardado — a autoria e a data não são do cliente.

**A armadilha concreta:** `inspections` é uma **lista**, não um mapa por portão, apesar de o
`DATA-MODEL.md` a ter desenhado com `gate` como chave (corrigido nesta versão). O
`store.js` faz `push`. Espalhá-la para dentro de um objeto literal dá `{0:…,1:…}` e o
`for…of` do `sanitizeInspectionPhotos` rebenta na gravação seguinte. **Ler o produtor antes
de escrever o consumidor** — o diagrama estava errado e o código não.

**Ordem importa:** a junção corre **antes** da contagem de NCs validadas, senão a guarda
compara contra uma lista que já não é a que vai ser gravada.

---

## 1.23.2 (2/2) — Sanear campos e depois guardar o objeto inteiro não é sanear

**O defeito, em duas linhas.** `POST /api/parties` fazia `String(p.email)`, `String(p.nif)`,
`delete p.contact` — e a seguir `appState.parties[i] = p`, o objeto **que veio no corpo**.
Saneavam-se os campos conhecidos e guardava-se tudo o resto na mesma, incluindo o que o
autor da chamada inventasse. O `type` era texto livre e o `renderParties()` imprimia
`typeLabels[p.type] || p.type` **sem escapar**. CSP com `'unsafe-inline'`. Resultado: XSS
persistente a correr na sessão de quem abrisse o ecrã de Fornecedores, administrador
incluído.

**Regra:** construir o objeto a guardar **campo a campo**, nunca `= body`. Uma lista branca
é a única forma que o autor da chamada não consegue estender. Aqui são sete campos (`id`,
`name`, `type`, `email`, `phone`, `nif`, `address`) e um `PARTY_TYPES` de cinco valores; um
tipo fora da lista cai para `supplier` em vez de ser guardado.

**Duas defesas, não uma.** O escape no cliente (`esc(p.type || '')`) fica na mesma. A lista
branca impede que entre; o escape impede que faça mal o que já lá estivesse guardado de
antes. **Uma correção de armazenamento não limpa o que já está gravado** — no v1 não havia
nada gravado para limpar; no V2, se este padrão aparecer, é preciso uma passagem pelos
dados existentes além da correção do endpoint.

**Onde mais procurar isto:** qualquer handler que sanei campos e depois persista o corpo. O
sinal é a variável do corpo e a variável guardada serem a mesma.

---

## 1.23.0 — Filtros: medir antes de desenhar

**O método, que vale mais do que o resultado.** Contei, contra os dados reais, quantas
opções cada filtro oferecia: Unidade **1** (só `un`), Projeto nos Movimentos **0**, e cinco
das seis vistas devolviam **0 linhas**. Um filtro com menos de duas respostas possíveis não
é um filtro — é mobília que se lê como funcionalidade.

**Regra:** desenhar um controlo só quando ele pode mudar o que está no ecrã.
`unitsInUse.length > 1`, `stockMoves.some(m => m.projectId)`, `stockMoves.some(m =>
m.factoryId)`. O controlo volta sozinho quando os dados justificarem.

**Select → fichas com contagem.** Um `select` **esconde o seu próprio vazio**: só se
descobre que «Saldos negativos» não devolve nada depois de o escolher. Uma ficha traz o
número consigo e responde sem clique. Uma fica visível a zero (`showAtZero`) porque «nada
abaixo do mínimo» é uma resposta que se quer ver; as outras desaparecem.

**Redundância eliminada:** o `select` de 119 componentes nos Movimentos foi substituído por
uma ficha removível, porque desde a 1.17.0 a pesquisa cobre nome e todos os descritores.
Manteve-se o filtro exato por id (o salto a partir do 🕐) — o que se removeu foi a lista,
não a capacidade. **Ao alargar uma pesquisa, procurar o controlo que ela tornou
redundante**; senão ficam os dois e o ecrã cresce sozinho.

---

## 1.22.0 — A guia por e-mail, e porque NÃO se usou o endpoint que já existia

**`POST /api/stock/guia-email` recebe `{ts, factoryId}` e mais nada.** O destinatário sai da
ficha da entidade; as linhas saem do livro de movimentos; o corpo é composto no servidor.

**Porque não reutilizar o `/api/send-email`:** esse aceita `to`, `subject` e `text` do
cliente (com guardas de cabeçalho e limite horário) porque serve para uma pessoa escrever
uma mensagem. Se a guia fosse por ali, qualquer sessão GC passaria a ter um caminho para
enviar texto arbitrário para endereço arbitrário com o remetente do domínio. **Um endpoint
que compõe a partir dos seus próprios registos não pode ser reaproveitado para spam** —
verificado: `to` e `text` enviados no corpo são ignorados.

**Custo honesto desta escolha:** o documento é composto duas vezes — HTML no cliente para o
ecrã, texto no servidor para o e-mail. Podem divergir na apresentação. **Não podem divergir
nos factos**, porque ambos leem o mesmo livro. Se um dia a divergência de layout incomodar,
a resposta é o servidor devolver o corpo para o cliente pré-visualizar — nunca o cliente
mandar o corpo para o servidor enviar.

**Nada sai sem clique.** Foi escolha explícita do José entre isso e uma caixa pré-marcada na
folha de envio: confirmar uma carga e mandar um papel para fora da empresa são dois atos.

---

## 1.21.1 — A máscara que existia num sítio e faltava noutros

**O defeito.** O `GET /api/state` filtrava o componente para contas ligadas a uma fábrica
(`warehouseQty: null`, só a sua chave em `factoryQty`) — **em código inline dentro do
handler**. As respostas de `/api/stock/move`, `/reverse`, `/send-batch` e do arquivo
devolviam `{ component: comp }`, o objeto partilhado e cru. O `store.js` grava a resposta
no estado local, portanto qualquer marcação de uma conta externa substituía a cópia
filtrada pelos números reais.

**A regra a levar, e é mais geral do que este bug:** quando uma entidade tem de ser
**mascarada antes de sair do processo**, a máscara é uma função e **todas as saídas
chamam-na**. Escrita à mão dentro de um handler, é uma questão de tempo até existir uma
segunda saída que a esquece — aqui eram quatro. Vale a pena procurar as saídas por
`grep` do nome do campo, não por memória.

**O que isto diz sobre testes:** os testes da 1.16.0 (16 verificações) provaram a
filtragem no GET e nunca olharam para o corpo de uma resposta de escrita. **Um teste de
uma fronteira de dados tem de cobrir todas as respostas que atravessam a fronteira, não o
endpoint onde a fronteira foi escrita.**

**Mais duas assimetrias da mesma família**, ambas entre o que o cliente oferece e o que o
servidor aceita: `/api/stock/reverse` só admitia `factory` enquanto `/move` já admitia
`site` (botão desenhado, 403 garantido); e `stockScope()` mandava para `none` apenas o
papel `factory`, deixando uma conta `site` por ligar cair em `all` — invisível na leitura,
permissiva na escrita. **Sempre que um papel ganha uma capacidade, procurar TODOS os
endpoints que a exercem, e o cliente que a desenha.**

---

## 1.21.0 — Devolução, consumo em obra, e uma separação de funções que caiu

**Devolução (`type: 'return'`).** O inverso exato do `send`. **Não** são dois `adjust`:
um acerto diz "o número está errado", uma devolução diz "voltaram 12 da fábrica" — coisas
diferentes que só se distinguem se forem tipos diferentes. Recusa devolver mais do que está
lá, e o estorno repõe no destino. **Regra:** quando um movimento tem uma explicação
própria, dá-lhe um tipo; um par de correções perde a explicação no momento em que é gravado.

**Consumo fora da fábrica.** Os `FACTORY_MARK_TYPES` (use/defect/loss) passam a valer em
qualquer sítio que segure stock, e o papel `site` entra na lista de quem os pode registar.
O que destrancou isto foi a ligação conta↔entidade da 1.16.0: um `site` ligado a uma obra
recebe o saldo dessa obra e mais nada, exatamente como uma fábrica. **Sem a ligação
continua a não ver nada** — o mesmo princípio de "não configurado ≠ com direito a tudo".

**Reimpressão da guia.** Nenhum registo novo: procura os `send` com o mesmo `ts` e o mesmo
destino. Foi por isso que a matrícula e a hora ficaram em **cada linha** do lote — sem isso
não haveria por onde reconstruir.

---

## 1.21.0 (parte 2) — O encarregado com poderes de diretor

**Decisão do José, 2026-08-05, com o aviso dado uma vez e recusado.** O `foreman` entra em
`FULL_ACCESS_ROLES`, `CREATOR_ROLES`, `NC_VALIDATOR_ROLES` e `SD_VALIDATOR_ROLES` — mais
`WAREHOUSE_ROLES` no cliente, senão o servidor e o ecrã discordavam sobre se ele é
restringível por fábrica.

**O que isto custa, escrito para quem vier depois:** o encarregado é quem marca uma não
conformidade como **reparada**. Agora também a **valida**. A separação de funções que existia
ali — quem executa não assina — deixou de existir. Não é um defeito: é uma escolha do dono do
produto, informada, e está registada aqui para que ninguém a leia como descuido.

**Duas lições de mecânica, independentes da decisão:**
1. **Papéis vivem em listas espalhadas por dois ficheiros.** Foram precisas seis edições
   (`serve.mjs` × 4, `store.js` × 4, `app.js` × 2) para uma única frase de negócio. No V2,
   **uma tabela de capacidades por papel, num sítio só**, e o cliente lê a mesma tabela — não
   uma cópia dela.
2. **Cliente e servidor têm de concordar sobre permissões, mas por espelho e não por
   duplicação.** Aqui as constantes estão escritas duas vezes; divergirem é uma questão de
   tempo, e a divergência aparece como um botão que existe e dá erro ao ser carregado.

---

## 1.20.0 — Destino do stock, e um papel que diz o que não é

**Obra passa a ser destino.** `stockDestination(id)` aceita `factory` **ou** `site`. O saldo
continua em `component.factoryQty`, com o nome agora mais estreito do que a coisa que
guarda — **renomear obrigava a migrar todos os componentes e não valeu o risco hoje**. Está
comentado no código: quem estender lê a função, não o nome. **No V2 chamar-lhe
`heldQty`/`atPartyQty` desde o início.**

**O documento de acompanhamento é reconstruído do livro, não guardado.** Uma remessa não é
uma entidade: é exatamente o conjunto de movimentos que partilham `ts` + destino. A
matrícula e a hora de início ficam em cada linha do lote. Assim o documento pode ser
reimpresso mais tarde e **nunca pode discordar do stock** — o que discordaria se houvesse um
segundo registo paralelo.

**A decisão que mais importa aqui não é técnica.** O documento diz, em vermelho e no topo,
que é interno, que não foi comunicado à AT e que não substitui a guia legal. **Um papel com
ar oficial que não o é seria pior do que papel nenhum** — alguém transportaria material a
julgar-se coberto. Se o V2 vier a comunicar mesmo à AT (SOAP com WS-Security, palavra-passe
cifrada com o certificado da AT — dá com o `node:crypto` puro), esse aviso sai; até lá fica.
E antes de escrever uma linha disso: perguntar se o ERP da empresa já emite guias, porque
dois sistemas a numerar documentos de transporte da mesma empresa é um problema de
compliance, não uma funcionalidade.

**Impressão sem biblioteca:** `@media print` esconde tudo menos o modal e o browser imprime
para PDF. Não é preciso mais nada, e neste alojamento não haveria como instalar mais nada.

**Terceiro caso do mesmo defeito num dia:** o `stockSendBatch` do `store.js` destruturava
`{factoryId, note, lines}` e reconstruía o corpo do pedido — a matrícula e a hora,
acrescentadas depois, desapareciam a caminho do servidor sem erro nenhum. Antes disso foi o
`apiCall` a deitar fora o `duplicateOf`. **Uma função de passagem que enumera campos é uma
função que vai perder o campo seguinte.** Passar o objeto inteiro.

---

## 1.19.0 — Texto livre → lista fechada, e o `node --check` que mente

**A alteração.** O `type` do componente deixa de ser texto livre e passa a
`material | equipment | consumable`. A tabela de conversão das 16 famílias antigas
(`TYPE_FROM_FAMILY` em `xlsx-stock.mjs`) é usada **nos dois sítios** — na migração única
do arranque e na importação de folhas — para que uma linha que chegue amanhã caia onde a
linha de ontem caiu. **O que a tabela não conhece fica vazio, nunca adivinhado:** um campo
por preencher pede resposta, um campo errado não.

**Padrão a repetir:** ao fechar um campo que era livre, a conversão e a validação futura
têm de ser a MESMA função. Se forem duas, divergem no primeiro valor novo.

**O ⓘ.** Um `title` nativo, não um tooltip próprio: funciona em qualquer browser, não
precisa de posicionamento e é lido por leitores de ecrã. As definições ficam **onde se
escolhe** — a dúvida "material ou consumível?" aparece nesse momento, e a resposta tem de
estar ali.

---

## 1.19.0 (parte 2) — `node --check` devolve 0 num ficheiro `.js` partido

**Medido, não suposto.** Um ficheiro com `import` e um erro de sintaxe:

| ficheiro | `node --check` |
| --- | --- |
| `.js` **sem** `import` | exit 1 — deteta |
| `.js` **com** `import` | **exit 0 — não deteta** |
| `.mjs` com `import` | exit 1 — deteta |

**Todos os ficheiros do cliente deste projeto são a linha do meio.** Portanto o
`node --check js/app.js` que usei a sessão inteira nunca foi uma verificação — foi um
ruído com aparência de aprovação. Foi assim que uma quebra de linha dentro de uma string
passou para o `app.js` e deixou a página em branco.

**A correção no `tools/check-i18n.mjs`:** cada ficheiro do cliente é copiado para um
`.mjs` temporário e verificado aí. Testado a falhar com as duas formas reais (quebra de
linha numa string, apóstrofo sem escape) e a passar com a árvore limpa.

**Para o V2, e é maior do que o i18n:** uma ferramenta de verificação pode responder
"passou" sem ter verificado nada. **Antes de confiar numa, parti-la de propósito e ver se
ela grita** — e reparar que a resposta pode depender da extensão do ficheiro, não do
conteúdo. Ficheiros de cliente com `.mjs` em vez de `.js` teriam evitado isto de origem.

---

## 1.18.0 — Duplicados: o que se pode impedir e o que só se pode mostrar

**A pergunta era "como verifico se já existe?" e a resposta útil é: em duas camadas, porque
são dois problemas diferentes.**

**Camada dura — a identidade exata.** `nome + medida + localização` (a MESMA chave que a
importação usa, `componentKey`). Recusa com 409 e devolve `duplicateOf: {id, name}` para o
cliente poder oferecer "abrir essa". Usar a mesma identidade nas duas portas — formulário e
folha de cálculo — é o ponto: uma referência escrita à mão passa a ser reconhecida quando a
mesma linha chegar num ficheiro, em vez de duplicar.

**Camada mole — os parecidos.** Lista viva por baixo do campo do nome, sem acentos nem
maiúsculas, com medida, palete e saldo. Não bloqueia.

**Porque não uma regra só, e esta é a parte a levar:** foi preciso olhar para os dados reais
antes de escolher. Neste armazém, **quatro** grupos partilham o nome e distinguem-se pela
medida, e **uma** referência de fornecedor vive legitimamente em duas paletes. Uma restrição
de unicidade sobre o nome, ou sobre a referência, teria recusado dados verdadeiros no dia em
que fosse ligada. **Antes de impor unicidade sobre um campo, contar quantas linhas
verdadeiras a violam** — a resposta quase nunca é zero.

**Porque prevenir e não um relatório de duplicados:** o duplicado leva saldo de abertura no
momento em que nasce, e a partir daí não pode ser apagado (movimentos). Sobra arquivar um e
ficar com o saldo dividido entre dois registos. O custo de limpar é permanente; o de impedir
é um `find` antes de gravar.

**Detalhe do cliente que valia um bug:** o `apiCall` do `store.js` reconstruía o objeto em
caso de erro (`{ok:false, error}`) e deitava fora tudo o resto — o `duplicateOf` nunca
chegava a quem o pediu. **Uma recusa costuma trazer a parte útil**; propagar o corpo inteiro
do erro em vez de o reconstruir.

---

## 1.17.0 (parte 3) — A verificação que não falha não é uma verificação

Depois do apóstrofo (abaixo), o mesmo tipo de erro repetiu-se horas depois: uma quebra de
linha dentro de uma string do dicionário. E **a verificação que eu tinha escrito para o
apanhar não o apanhou** — porque estava a filtrar a saída com `grep`, o script rebentou, o
`grep` não encontrou nada, e o silêncio pareceu sucesso.

**Ficou `tools/check-i18n.mjs` (`npm run check`)**, e o que interessa para o V2 é o que ele
verifica, por esta ordem de importância:
1. **importa** os dois dicionários como o browser importa (o `node --check` passa por cima
   de um erro destes);
2. paridade de chaves nos dois sentidos;
3. **todas as chaves `t('…')` do código existem** — a paridade `en`↔`pt` não vê uma chave
   que falte em ambos;
4. prefixos dinâmicos (`t('unit.' + u)`) têm pelo menos uma chave;
5. os **marcadores `{n}` coincidem** entre idiomas.

**E foi testado a falhar nos três casos** (apóstrofo, chave em falta, marcador diferente)
antes de se acreditar nele. Uma verificação que nunca se viu falhar não prova nada — e uma
verificação cuja saída se filtra deixa de ser uma verificação.

---

## 1.17.0 (parte 2) — Um apóstrofo derrubou a aplicação inteira num idioma

**O incidente.** Numa string nova do dicionário inglês ficou `factory's` dentro de aspas
simples, sem escape. O módulo deixou de fazer parse. Foi para produção na 1.16.0 e só
apareceu quando o José entrou com uma conta em inglês: **todos os textos do ecrã passaram a
ser as próprias chaves** — `view.dashboard`, `DASHBOARD.KPI.PROJECTS`, tudo. Não foi um
texto em falta; foi a aplicação inteira ilegível, para quem tinha aquele idioma.

**A causa arquitetural, e é a parte a levar para o V2.** Os dicionários são carregados um de
cada vez (decisão certa: os dois juntos eram 81 KB por carregamento). Mas isso removeu o
recurso: `setLang()` faz `dict = mod.default` depois de um `await`. Se o import rebentar, o
`dict` fica `{}` e o `t()` — que devolve a chave quando não encontra, o que é bom
comportamento para uma chave em falta — devolve **todas** as chaves. Uma otimização de
payload transformou um erro de sintaxe numa falha total de interface.

**O que o V2 deve fazer diferente:** o carregador tem de apanhar a falha e cair para o outro
dicionário (`try { await load(lang) } catch { await load(fallback) }`). Um idioma partido
passa a ser "aparece em português", não "aparece em código". Enquanto o `t()` for a única
defesa, ele defende contra a chave que falta e não contra o ficheiro que não abre — que é o
caso grave.

**Porque nenhuma das verificações apanhou isto — as três falhas valem mais do que o bug:**

1. **`node --check ficheiro.js` PASSA neste erro.** Não avalia o módulo como ESM, portanto a
   string malformada nunca chega a ser lida. Estive a sessão inteira a confiar nisto.
   **A única verificação honesta é importar o módulo como o browser importa.**
2. **A verificação de paridade não vê nada.** Comparava as CHAVES de `en` contra `pt`, e a
   chave existia nos dois. O que estava partido era o VALOR. Paridade de chaves não diz nada
   sobre o conteúdo ser válido.
3. **Todos os testes de browser correram na conta de administrador, que está em português.**
   Um defeito por idioma é invisível se só se testa num idioma.

**Verificações que ficam (e que o V2 deve ter desde o início):**
- importar os dois dicionários e confirmar que carregam;
- extrair todos os `t('chave')` literais do código e confirmar que cada um existe nos dois —
  a paridade `en`↔`pt` não cobre uma chave que falte em AMBOS;
- para prefixos dinâmicos (`t('unit.' + u)`), confirmar que existe pelo menos uma chave com
  esse prefixo.

**Lição mais geral, sem ser sobre i18n:** quando se remove uma redundância por causa de
custo (aqui, carregar só um dicionário), fica-se com um ponto único de falha que **antes não
existia**. Vale a pena perguntar, na altura, o que acontece quando essa única peça falha —
neste caso a resposta certa era três linhas de `catch`.

---

## 1.17.0 — Envio em lote, e porque tem de ser um endpoint

**`POST /api/stock/send-batch`** — `{ factoryId, note, lines: [{componentId, qty}] }`.

**Porque não são N chamadas ao `/api/stock/move` que já existia.** Porque a propriedade que
interessa é a atomicidade. Com N chamadas, a linha 14 que excede o saldo deixa treze
referências já registadas como saídas: o livro diz que saíram, o camião diz que não, e
alguém desfaz aquilo à mão. O endpoint valida **todas** as linhas e só depois escreve.

**Duas linhas com a mesma referência somam-se antes de validar.** Senão cada uma passa o
teste contra o mesmo saldo e o armazém fica negativo — o erro clássico de validar item a
item em vez de validar a procura total.

**Cada linha continua a ser um movimento próprio** (mesma data, mesma nota). Os saldos e os
estornos são por componente; um movimento agregado obrigaria a desfazer o lote inteiro para
corrigir uma linha.

**No cliente, o estado é um `Map` componente→quantidade fora do DOM.** A lista refiltra-se a
cada pesquisa e o DOM é descartado; guardar a quantidade no `input` perdia tudo o que já
tinha sido escrito assim que se procurasse a referência seguinte. Com 119 referências,
escrever por partes é o uso normal, não a exceção.

**Lição de UX que vale a pena levar:** o teto tem de estar visível no sítio onde se escreve.
O saldo aparece ao lado de cada campo e o excesso é assinalado enquanto se escreve — saber
no fim que uma das vinte linhas era impossível é o pior momento para saber.

**Também:** um `select` vazio não comunica nada. O campo Fábrica na ficha de utilizador
mostrava uma lista sem opções quando não havia partes do tipo `factory`, e leu-se como
"ainda não implementado" — foi exatamente assim que foi reportado. Passa a dizer o que
falta criar. **Sempre que uma lista puder estar vazia por falta de dados noutro sítio, o
estado vazio tem de nomear esse sítio.**

**E o erro que veio a seguir, que é o mais fácil de repetir.** A mensagem nova mandava pôr
o tipo «Fábrica». **Esse rótulo não existe em lado nenhum do ecrã**: as opções são «Empresa
fornecedora» e «Empresa de fabrico (off-site)». O mesmo conceito tem três nomes no produto —
`factory` no código, «Fábrica» no campo da conta, «Empresa de fabrico (off-site)» na lista
de tipos — e a ajuda escolheu o nome errado dos três. Mandar alguém procurar um rótulo que
não existe é pior do que não dizer nada.

**Para o V2:** um conceito, um nome visível. Se o código lhe chama `factory`, o ecrã não lhe
pode chamar «Fábrica» num sítio e «Empresa de fabrico» noutro — e **texto de ajuda que cita
uma opção tem de citar a string do dicionário, não uma paráfrase escrita de memória**.
Ligado a isto: só o tipo `factory` pode ter saldo, receber envios ou ser ligado a uma conta;
`supplier` é aceite em pedidos mas é invisível para o stock, e nada avisa disso.

---

## 1.16.0 — Um nome só, e o stock que pertence a uma fábrica

**Parte 1 — a fusão das duas descrições.** `description` desaparece do componente; o `name`
absorve-a (`mergeName`: iguais → um; um contém o outro → o maior; senão → `a — b`).

**O que faz disto uma migração e não uma mudança de ecrã:** a identidade que a importação
usa era construída a partir dos DOIS textos. Mudar o que a folha produz sem refazer as
chaves guardadas faz a importação seguinte não reconhecer nada e duplicar o armazém inteiro.
A migração corre uma vez (`descMergedAt`, no `meta`), funde os nomes e **recalcula
`importKey`**. Verificado: reimportar depois dá 0 criadas / 119 atualizadas.

**Regra geral para o V2:** quando uma chave de identidade deriva de campos visíveis, uma
alteração de apresentação torna-se uma alteração de dados. Ou a identidade é opaca e estável
desde o início (o melhor), ou toda a mudança nesses campos arrasta uma migração das chaves.

**Parte 2 — stock com dono.** A conta ganha `partyId` (uma parte do tipo `factory`),
validado contra as partes existentes: um id à mão ou de um fornecedor ficaria "ligado" mas
comportar-se-ia como "cego".

`stockScope(user)` devolve três respostas — `all` (armazém: admin e os dois diretores),
`{factory}` (ligada a uma fábrica) e `none` (conta de fábrica ainda por ligar). **A ligação
manda, não o perfil**, exceto nos três que gerem o armazém — senão ligar um diretor a uma
fábrica trancava-o fora do armazém que ele administra.

**A filtragem é no `/api/state`, não no ecrã.** Uma conta ligada recebe o catálogo mas com
`warehouseQty: null` e só a sua chave em `factoryQty`. **`null`, não `0`** — zero é uma
afirmação sobre o stock e seria mentira; `null` diz "não é da tua conta" e o cliente desenha
um travessão. Obriga a proteger todo o cliente que fazia aritmética com esse número
(mínimos, ordenação, saldos negativos).

**`none` vê zero e escreve zero**, por escolha do José: o significado seguro de "ainda não
configurado" é "sem direito", nunca "com direito a tudo". Consequência operacional: ao
instalar, a conta de fábrica existente fica cega até ser ligada.

Escrita protegida nos dois sítios que mexem em saldos — `/api/stock/move` e
`/api/stock/reverse`. Um estorno é uma escrita como outra qualquer e obedece à mesma
fronteira. 16 verificações, incluindo que nenhum saldo de outra fábrica sai do processo.

---

## 1.15.0 — Arquivar, e a pesquisa que não sabia o que procurava

**O problema, que é uma consequência e não um defeito.** A regra "um componente com
movimentos não se apaga" existe desde sempre e está certa. Mas antes da importação um
componente acabado de criar não tinha movimentos, portanto era apagável enquanto ainda era
só uma entrada de catálogo. Ao fazer o saldo inicial entrar como movimento a sério — que
também está certo — 116 das 119 referências ficaram permanentes no minuto zero.

**A lição para o V2:** quando se torna um registo obrigatório, verifica-se o que passa a
ser impossível. Duas regras individualmente corretas produziram um catálogo imutável, e
nenhuma delas estava errada.

**Forma de dados:** `archivedAt` (ISO) + `archivedBy` no componente. Ausentes = ativo. Data
e autor, não um booleano — o V1 grava sempre quem e quando.

**Endpoint próprio** (`POST /api/components/:id/archive`), NÃO um campo no save do
componente. Duas razões, ambas práticas: o formulário de edição não pode virar a bandeira
por acidente, e a reimportação — que escreve descritores por esse mesmo save — deixa a
decisão humana em paz. Se isto fosse um campo na lista branca, cada importação
desarquivaria tudo o que a folha ainda menciona.

**A distinção que estrutura o código:** `activeComponents()` para tudo o que **olha para a
frente** (encomendas novas, linhas de receita, escolher para movimentar, avisos de mínimo);
`state.components` inteiro para tudo o que **olha para trás** (o livro de movimentos, uma
receita já escrita, uma encomenda já feita). Confundir os dois faz o arquivo apagar o
passado em vez de fechar o futuro. Caso concreto: no editor de receitas, uma linha que já
aponta para um componente arquivado tem de continuar a listá-lo — filtrar sem exceção faria
o `select` cair no primeiro da lista e mudar uma receita que ninguém mandou mudar.

**Pesquisa no livro de movimentos.** Procurava em `note`, `orderCode` e `by`. Um movimento
guarda um `componentId`, e as palavras que uma pessoa conhece — "PARAFUSO", "PALETE 07",
"ROTHOBLAAS" — estão na ficha do componente. Passa a montar o texto pesquisável juntando o
componente ao movimento, com um `Map` construído uma vez e não por linha. **Regra geral:
o texto pesquisável de um registo tem de incluir aquilo que a pessoa sabe sobre ele, não
aquilo que a linha guarda.**

---

## 1.14.1 — Negar por extensão, não por nome

**O defeito.** `BLOCKED_STATIC` (serve.mjs) enumerava `(serve|db)\.mjs$`. Uma lista que
enumera é uma lista que fica para trás: `train-log.mjs` (1.7.0) e `xlsx-stock.mjs` (1.14.0)
foram ambos servidos como texto desde o dia em que nasceram. Trocado por `\.mjs$`.

**A regra para o V2, e é geral:** um denylist de caminhos deve fechar por **categoria**
(extensão, pasta), nunca por inventário de nomes — senão cada ficheiro novo entra do lado
errado da defesa e ninguém repara, porque nada falha. Antes de o fazer é preciso confirmar
que a categoria não apanha nada que o cliente carregue; aqui o cliente é todo `.js` e
nenhum `.mjs` é pedido pelo browser.

**O que isto também mostra:** as duas defesas (a do Node e a do `.htaccess`) tinham
conteúdos diferentes e ninguém dava por isso, porque na produção só a segunda é que
trabalha. Sempre que houver duas camadas para a mesma coisa, a que não está a ser exercida
apodrece em silêncio — ao reimplementar, verificar as DUAS camadas, não só a que o código
mostra.

---

## 1.14.0 — Descritores de armazém e importação de inventário

**Forma de dados.** O componente ganha sete campos, todos opcionais e todos texto:
`description`, `type`, `size`, `standard`, `brand`, `location` e `importKey`. Nada é
obrigatório e nada tem valor por omissão — uma base de dados existente continua válida sem
migração. No `serve.mjs` são aparados e limitados (60–300 caracteres) na lista branca de
`/api/components`; **a lista branca é o sítio certo**, porque a importação escreve centenas
destes de uma vez e não passa pelo formulário.

**Ficheiro novo: `xlsx-stock.mjs`.** Lê um `.xlsx` sem dependências — um `.xlsx` é um zip de
XML e o `node:zlib` chega para o abrir. Duas metades: leitor de folha genérico
(`readWorkbook`) e mapeamento de domínio (`planStockImport`). No TwinLab isto reescreve-se,
não se copia; o alojamento também não instala bibliotecas, por isso a abordagem serve.

**Três armadilhas que custaram tempo e vão repetir-se:**
1. **A célula vazia.** No XML, uma célula sem valor simplesmente não existe, e a posição só
   se sabe pelo atributo `r="H2"`. Pior: com uma captura de atributos gulosa (`[^>]*`), o
   `/` de um `<c r="A2"/>` é consumido, a alternância cai no ramo do `>` e a procura do
   `</c>` atravessa as células seguintes — e as linhas seguintes. A quantidade aparecia na
   coluna da norma. **A captura tem de ser preguiçosa.**
2. **A identidade da linha.** Seis linhas deste armazém são todas "CHAPA PILARES 1cm" na
   mesma palete, distinguidas só pelo furo escrito na DESCRIÇÃO. Uma chave por
   nome+medida+localização apaga 15 peças reais como "repetidas". A chave tem de incluir a
   descrição.
3. **A chave guardada.** Guardar a chave no componente (`importKey`) e casar por ela antes
   de recalcular: senão, mudar uma referência de palete dentro da aplicação faz com que a
   importação seguinte da mesma folha não a reconheça e crie uma segunda cópia.

**Invariante a manter.** Saldo de abertura entra como **movimento** (`type: 'in'`), nunca
como número atribuído. E numa reimportação só se atualizam descritores: **a folha manda nos
descritores, o histórico de movimentos manda nos saldos.** Se estes dois donos se
confundirem, uma reimportação apaga consumos reais.

**Duas passagens sobre o mesmo upload** (`POST /api/stock/import`, `?commit=1` na segunda).
A primeira não escreve nada e devolve o plano. Importar um documento de outra pessoa sem
dizer primeiro o que se percebeu dele é adivinhar em nome dela.

**Permissão:** só `admin`. É o único ponto que cria centenas de registos num ato.

---

## 1.14.0 (parte 2) — A reposição que não ficava reposta

**O defeito, e é de desenho, não de escrita.** O cliente tratava "servidor vazio" como
"instalação anterior ao servidor, por migrar" e reenviava o seu `localStorage`. Um
administrador apagava tudo; o telemóvel seguinte a abrir a aplicação repunha tudo. Verificado
aqui: 3 projetos e 14 pedidos voltaram sozinhos.

**A correção.** Um marcador `resetAt` gravado no servidor no momento em que se apaga, e o
cliente não semeia quando ele existe. Vazio-por-nascimento e vazio-por-decisão passam a ser
estados diferentes — que é o que faltava.

**Para o V2:** qualquer sincronização que trate "o outro lado está vazio" como convite a
enviar precisa desta distinção. Reparar que `db.mjs` guarda o `meta` por lista explícita de
chaves: uma chave nova não persiste só por se juntar ao objeto de estado.

---

## 1.13.1 — Sincronizar ao voltar ao ecrã

**O que faz.** Um ouvinte de `visibilitychange` (e outro de `online`) que dispara a mesma
verificação de revisão que a sondagem periódica já fazia.

**Porque é obrigatório numa PWA, e não era antes.** Numa página de browser normal, sair e
voltar recarrega. Instalada, a app fica **residente**: o iOS suspende os temporizadores e
deixa cair a ligação de eventos enquanto está em segundo plano. Ao reabrir, o ecrã mostra o
estado de quando foi guardada, e a primeira ação do utilizador — que é precisamente o que se
faz ao reabrir — leva uma versão velha e é recusada pelo guarda de concorrência.

**A lição para o V2:** ao tornar uma aplicação instalável, o ciclo de vida muda de "carrega,
usa, fecha" para "acorda, usa, adormece". Todo o código que assumia um carregamento fresco
tem de ganhar um gancho de retoma. Isto vale para a sincronização, para tokens com prazo, e
para qualquer coisa que dependa de um temporizador.

**Nota:** o 409 continua a aplicar-se a toda a gente, **incluindo ao administrador**. Não é
uma permissão — é o facto de outra pessoa ter escrito primeiro. As quatro passagens de
administrador do v1 (desenhos, carga em trânsito, data JIT, apagar iniciado) são regras de
processo, e essas sim podem ser ultrapassadas, sempre com registo no histórico do pedido.

---

## 1.13.0 — PWA: instalável, rede primeiro, offline só para arrancar

**O que faz.** `manifest.json` + `sw.js` + ícones. Instala no ecrã inicial, abre em
standalone, e abre sem rede com o último estado conhecido.

**A decisão que interessa levar: rede primeiro, sempre.** Um service worker *cache-first*
faz a aplicação parecer instantânea e transforma cada deploy numa lotaria — o telemóvel
continua a correr o código de ontem. Isto já custou dados a este projeto uma vez (um
`store.js` em cache importou um dataset sem `procurement` e o servidor gravou lista
vazia), e um service worker teria feito essa falha sobreviver a um recarregamento. O
worker vai à rede, escreve na cache de passagem, e só lê da cache quando a rede falha.

**Invariantes:**

1. **Nada sob `api/` é cacheado.** As respostas são por conta, e um telemóvel de obra não
   anda sempre no mesmo bolso. O "último estado conhecido" vem do `localStorage` que o
   `store.js` já mantinha, não do worker.
2. **O motor 3D não é pré-carregado.** São 6,4 MB; pré-carregá-los faria a instalação
   descarregar isso para quem só quer ver uma data de entrega.
3. **O nome do ficheiro do manifesto é uma armadilha, e eu caí nela.** Escolhi
   `manifest.json` em vez de `.webmanifest` para o servidor web reconhecer o tipo — e em
   produção deu **403**, porque a auditoria de segurança tinha posto no `.htaccess` uma
   regra a negar *todos* os `.json` (existe para tapar `package.json`, `smtp-config.json`,
   `state.json`). As duas decisões estavam certas isoladamente e colidiram.
   Resolve-se com uma exceção nomeada para esse ficheiro. **A lição para o V2:** antes de
   escolher a extensão de um ficheiro público novo, ler as regras do servidor à frente —
   não basta pensar no tipo de conteúdo, há também quem esteja a negar.
4. **Todos os caminhos do manifesto são relativos**, para o mesmo ficheiro servir na raiz e
   no sub-caminho `/twinflow`.
5. **`install` não usa `addAll`.** Um único 404 faria falhar a instalação inteira e a
   aplicação ficaria sem worker nenhum, sem pista do motivo. Cada ficheiro é pedido à parte
   e uma falha é sobrevivível, porque a cache é recurso de recurso.

**A correção de segurança que este trabalho destapou** — e que vale por si só, mesmo sem
PWA: `ensureAuth()` tratava **qualquer** falha do `api/me` como sessão inválida. Perder o
sinal apagava a marca de sessão e mandava o utilizador para o ecrã de entrada, e continuava
a mandar depois de a rede voltar. Agora distingue-se **"o servidor recusou" (401)** de
**"não consegui chegar ao servidor"**. Se o V2 tiver um arranque parecido, verificar isto
primeiro: é um bug de disponibilidade que só aparece em obra.

A conta recordada no `localStorage` é uma **pista de rendering, nunca uma permissão** — o
servidor continua a devolver 401 a cada chamada. Sair da conta limpa-a: terminar sessão tem de
significar sessão terminada, inclusive a cópia que o aparelho guarda para abrir sem rede.

**Nota de UX:** a primeira tentativa de avisar do modo offline foi um *toast*. É o
instrumento errado — desaparece em quatro segundos e a afirmação ("estes dados podem estar
velhos") continua verdadeira enquanto os dados estiverem no ecrã. Passou a ser uma barra
permanente que só desce quando alguma coisa chega mesmo à API; o evento `online` do browser
não chega, porque um telemóvel pode voltar a uma wifi de obra que não tem saída.

---

## 1.12.0 — Alertas de stock fundidos no resumo diário

**O que faz.** As duas faltas de stock (armazém e fábrica) deixaram de ser e-mails próprios
e passaram a ser secções do resumo por pessoa. Os dois envios independentes foram
**removidos**, não desativados.

**A razão, que é a parte a levar.** Um alerta por tema parece organização e é fragmentação:
a mesma pessoa recebia três mensagens na mesma manhã, cada uma com um pedaço do seu dia.
Se o V2 nascer com notificações, começar por aqui — **um destinatário, uma mensagem, uma
vez** — poupa a refactorização que este commit foi.

**Consequências estruturais:**

1. **Dois relógios desapareceram.** `lowStockAlertedAt` e `lowFactoryAlertedAt` (trava de
   22h por alerta) deixaram de existir: a cadência passou a ser a do resumo, que é diária
   por utilizador. No v1 as chaves ficaram na instrução de `DELETE` do `db.mjs` mas saíram
   da de `INSERT`, para limparem sozinhas da base de dados na primeira gravação em vez de
   ficarem valores que ninguém lê.
2. **Stock não tem âmbito de projeto.** O catálogo e os saldos são infraestrutura global, ao
   contrário dos pedidos — por isso estas duas secções são iguais para todos os diretores,
   independentemente das obras que cada um tenha. Se o V2 tornar o stock por obra, isto
   muda.
3. **A hora do envio é configurável** por variável de ambiente (`TWINFLOW_DIGEST_HOUR`,
   0–23). Foi acrescentada para conseguir testar fora da janela, e ficou porque é uma
   decisão de operação, não de código.

**Nota de teste:** com o limiar em 07:00 e o relógio às 04:00 de Lisboa, o resumo não
enviou — o que é o comportamento certo e serviu de prova de que o cálculo de fuso funciona.
Para testar fora dessa janela, usar a variável.

---

## 1.11.0 — Resumo diário por perfil

**O que faz.** Um e-mail por dia por conta, listando apenas o que está à espera daquela
pessoa. Substitui a ideia de "mais um alerta por tema".

**Porque é assim.** O padrão que interessa levar não é o conteúdo — é a regra: **uma linha
só entra se o perfil que a recebe puder agir sobre ela.** Dizer a um encarregado que há
desenhos de fabrico por validar é verdade e é ruído. Foi isso que definiu as secções.

**Forma de dados (aditiva).** Um campo no utilizador:

```js
user.digestSentOn = 'YYYY-MM-DD'   // dia em que já recebeu; ausente = nunca recebeu
```

Guardado no registo do utilizador de propósito, e não numa chave global: no v1 o
`persistUsersDb` grava o objeto inteiro, por isso não é preciso mexer na lista explícita de
chaves `meta` — ao contrário dos marcadores dos digests de stock, que tiveram de lá entrar.

**Invariantes:**

1. **Silêncio quando não há nada.** O dia é marcado na mesma, mas não sai e-mail. Um resumo
   que diz "nada a reportar" é a forma mais rápida de ensinar as pessoas a ignorá-lo.
2. **Âmbito de projeto respeitado** — reutiliza a mesma função de acesso das rotas da API
   (`canAccessProject`). Verificado: um diretor limitado a um projeto recebe menos linhas
   que um com vários. Se o V2 tiver âmbito por projeto, o digest tem de passar por lá.
3. **Sem e-mail, sem digest.** É a forma de desativar, e é intencional: não há um botão
   próprio para isso.
4. **A hora é calculada em fuso explícito** (`Europe/Lisbon`, via `Intl`), não na hora do
   servidor — o processo corre num alojamento cuja hora não é a da obra. Sem isto o "resumo
   da manhã" chega a meio da noite meio ano por ano.
5. **Cadência de verificação != cadência de envio.** Os digests de stock usam trava de horas
   decorridas e podem ser verificados de 6 em 6h; este espera por uma *janela do dia* ("já
   passou das 07:00 e ainda não foi hoje"), por isso é verificado de 20 em 20 minutos. Uma
   verificação de 6h passa ao lado da manhã.

**Armadilha encontrada:** o servidor não tem os rótulos de estado — `STATUSES` vive no
`store.js`, que é código do cliente e não é importado no servidor. Uma verificação de
sintaxe não apanha isso; só rebenta em execução. O digest leva os seus próprios rótulos.

**Também neste commit:** o modo de teste do e-mail escreve no log o que teria enviado.
Antes, "modo de teste" queria dizer que ninguém conseguia verificar o que sairia.

---

## 1.10.0 — Stock mínimo por fábrica, com alerta próprio

**O que faz.** Além do mínimo de armazém que já existia, cada componente pode ter um mínimo
por cada fábrica. Quando o saldo numa fábrica cai abaixo do mínimo definido *para essa
fábrica*, sai um e-mail diário separado do de armazém.

**Forma de dados (aditiva).** Novo campo no componente:

```js
component.factoryMinQty = { [partyId]: number }   // ausente ou chave em falta = sem alerta
```

Convive com o `component.minQty` (armazém), que não muda. Registos antigos não têm o campo e
comportam-se como "sem mínimo" — não é preciso migração.

**Invariantes que têm de sobreviver à reescrita:**

1. **Em branco remove a chave; não guarda zero.** "Sem mínimo" e "mínimo de zero" são
   respostas diferentes, e só a primeira silencia o alerta. Um zero guardado avisaria sempre
   que o saldo fosse negativo.
2. **Só chaves que sejam fábricas reais sobrevivem.** O servidor filtra contra as `parties`
   de tipo `factory`; o que vier a mais é descartado em silêncio.
3. **Os saldos de fábrica podem ser negativos por desenho** — o consumo automático debita-os
   porque os elementos foram mesmo produzidos. Por isso um saldo negativo **não** é alerta
   por si só: só há alerta onde houver mínimo definido. Tratar "negativo" como alerta faz o
   e-mail disparar todos os dias e ensina toda a gente a ignorá-lo.
4. **Relógio próprio.** O digest de fábrica tem o seu marcador (`lowFactoryAlertedAt`),
   separado do de armazém (`lowStockAlertedAt`), com a mesma trava de 22h. Se partilhassem
   marcador, um a sair silenciava o outro nesse dia. **Ambos têm de ser persistidos** — no
   v1 a lista de chaves `meta` é explícita no `db.mjs`, e esquecer lá o marcador faz o alerta
   repetir a cada reinício do processo.
5. **Destinatários: só a direção.** `admin`, `project_director`, `site_director` com e-mail
   preenchido, num único e-mail com todas as fábricas. A fábrica **não** recebe: é uma
   empresa externa e não pode ver os saldos de outra — a mesma razão pela qual lhe foram
   retiradas as encomendas na auditoria de segurança.

**Ficheiros tocados no v1** (equivalentes a encontrar no V2):
`serve.mjs` (aceitação do campo no upsert de componentes + `sendFactoryLowStockDigest()` +
agendamento), `db.mjs` (persistência do marcador), `js/app.js` (modal do componente),
`js/lang/pt.js` e `js/lang/en.js` (duas chaves novas), `css/styles.css` (as linhas por
fábrica).

**Armadilha encontrada na implementação:** a regra `.form-row input:not([type="checkbox"])
{ width: 100% }` tem mais especificidade do que um seletor de duas classes, por isso o campo
numérico esticava para a largura toda do modal. Precisou de `.form-row .factory-min-row
input.factory-min`. Se o V2 tiver uma regra genérica parecida para campos de formulário, o
mesmo vai acontecer.

**Ainda por decidir (não implementado):** o alerta repete todos os dias enquanto a falta
existir — não tem memória do que já avisou, nem sabe se já há uma encomenda adjudicada para
aquela referência. Vale o mesmo para o alerta de armazém.

---

## Antes deste ficheiro existir (2026-08-01, resumo)

Estas entradas são um resumo curto: são anteriores ao pedido de registo, e o detalhe está no
`CHANGELOG.md`.

- **1.9.2** — O endereço sem barra final respondia com um reencaminhamento sem
  `Content-Type`; o servidor web preenche essa falta com `application/octet-stream` e o
  Safari do iOS oferecia-se para *transferir um ficheiro* em vez de abrir a aplicação. Se o
  V2 for servido num sub-caminho, verificar os cabeçalhos do reencaminhamento, não só o
  destino.
- **1.9.0 / 1.9.1** — Sistema de design: camada de tokens (escala tipográfica de nove
  degraus, grelha de 4px, quatro raios, três elevações, rampa neutra fria) que todos os
  componentes consomem. **Armadilha central:** seis tokens de cor eram os hex exatos dos
  estados em `store.js`, consumidos numericamente pelo three.js e concatenados com alfa
  (`${st.color}22`). Retocá-los parte a paleta em duas. A solução é ter dois níveis — a cor
  de estado (intocável) e uma tinta separada para quando a cor é *texto*.
- **1.8.1** — Auditoria de segurança: quatro correções, todas do mesmo feitio — uma
  verificação que existia num caminho e faltava no caminho paralelo. A lição para o V2 é
  essa: cada regra de acesso vale pelos caminhos TODOS que chegam ao mesmo recurso, e um
  registo que o cliente envia inteiro precisa de re-verificação campo a campo no servidor.
- **1.8.2** — O ecrã de entrada espera pelo servidor durante a janela de arranque, em vez de
  mostrar o erro `starting` em bruto.
