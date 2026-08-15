# Registo de versões — TwinFlow

Cada deploy leva um número próprio. O número aparece no rodapé da aplicação e em
⚙ Configuração → Sistema e sessão, ao lado da data de atualização dos ficheiros no
servidor — para responder, sem adivinhar, à pergunta "que código está a correr?".

Regra: `MAIOR.MENOR.CORREÇÃO`
- **MENOR** — funcionalidade nova ou alteração visível no fluxo de trabalho
- **CORREÇÃO** — correções e afinações sem alterar o que a aplicação faz
- **MAIOR** — alteração que obrigue a mudar a forma de trabalhar

As versões abaixo de 1.1.0 são reconstruídas a partir do histórico de alterações: são
anteriores à numeração e nunca chegaram a anunciar um número dentro da aplicação.

---

## 1.31.1 — 2026-08-10

**O aviso de "sem ligação" já se cala sozinho.** Ficava no ecrã depois de a ligação ter
voltado, e só desaparecia se recarregasses a página.

Acontecia sempre que era o **servidor** a ir abaixo e a voltar — uma reinicialização depois
de uma atualização, por exemplo. O aviso subia (a aplicação continuava a trabalhar com a
cópia guardada no aparelho, como deve) mas só descia quando era o **aparelho** a recuperar
a ligação, o que nesse caso nunca chega a acontecer. Entretanto a aplicação já estava a
receber dados novos do servidor, por baixo de um aviso a dizer que estavam velhos.

Agora **qualquer** coisa que chegue ao servidor faz o aviso descer: a sincronização de
fundo, uma alteração tua que passa, o retomar da ligação. Se o servidor estiver mesmo
inacessível, o aviso mantém-se — que é para isso que existe.

## 1.31.0 — 2026-08-10

**4D: ver o modelo a avançar no tempo.** No Modelo IFC há um botão **🎬 4D**. Com ele ligado
aparece uma barra com **▶ reproduzir**, uma **linha do tempo que se arrasta**, a **data** e a
velocidade. Em vez do estado de hoje, cada elemento fica pintado com o estado que **tinha
naquela data**.

**A data avança sozinha.** O ▶ percorre a obra do princípio ao fim em cerca de 20 segundos,
seja ela de uma semana ou de seis meses — e a velocidade (0.5× a 4×) é tua. Chegando ao fim
pára; carregar outra vez recomeça do princípio. Arrastar a linha do tempo assume o comando e
pára a reprodução.

**Não é só o pedido: é cada elemento.** Um painel fixado na terça-feira e o vizinho na
sexta-feira mudam de cor em dias diferentes, mesmo pertencendo ao mesmo pedido — as leituras
de QR da Montagem (fabricado, carregado, içado, fixado…) contam por elemento. Um elemento
nunca recua: se já está fixado, não volta a "entregue" quando o pedido inteiro lá chega dias
depois.

**A legenda passa a contar.** Enquanto corre, cada estado mostra quantos elementos estão nele
naquela data, e por baixo da barra fica escrito **o que mudou nesse dia** (que pedido, que
passo).

**"Ocultar o que ainda não foi pedido"** faz o edifício **crescer**: os elementos sem pedido
naquela data desaparecem, e vão aparecendo à medida que são pedidos. O Mapa de Quantidades
não se mexe com isto — as quantidades do modelo são as do modelo, esteja a data onde estiver.

**Não escreve nada.** Isto lê o histórico que a aplicação já guardava; não cria registos nem
altera pedidos. Um projeto sem histórico de pedidos di-lo e não abre a barra.

## 1.30.0 — 2026-08-06

**A expedição já comunica à AT.** Falta só o certificado que a AT tem de emitir — o resto
está feito e testado ponta a ponta contra um serviço de simulação.

**Ao enviar uma carga**, quem tiver as credenciais preenchidas na sua ficha vê uma opção
**Comunicar esta carga à AT** e escolhe o tipo de documento. O material teu que vai para a
tua própria fábrica é normalmente **GA**; para obra ou terceiros, **GT**. Se correr bem,
recebes o **Código AT** na hora e ele fica na carga.

**O envio nunca se perde por causa da AT.** O movimento de stock é gravado primeiro. Se a AT
estiver em baixo ou recusar, a carga fica registada na mesma, marcada como **por comunicar**,
e a aplicação diz-te porquê. Depois é só abrir o documento pelo 🧾 e carregar em **Comunicar
à AT** para repetir.

**A repetição não gasta outro número.** O documento já foi emitido com aquele número; repetir
comunica o mesmo documento, não um novo. E mantém o tipo com que foi numerado — um GT com o
número `GD 2026/1` seria um documento a contradizer-se.

**O documento de acompanhamento mudou de aviso.** Enquanto não estiver comunicado continua a
dizer, a vermelho, que é interno. Assim que houver Código AT passa a mostrá-lo a verde com o
número do documento. **E se estiver em ambiente de testes, di-lo** — um código de teste não
tem valor legal e não pode parecer que tem.

## 1.29.1 — 2026-08-06

**Nada muda no ecrã.** Ficou escrito o que fala com a AT: o XML do documento de transporte
e o mecanismo de segurança que a AT exige — a senha cifrada com uma chave gerada a cada
pedido, e essa chave cifrada com a chave pública da AT.

Ainda **não comunica nada**: falta ligar isto ao botão de expedição, e falta o certificado
que a AT tem de emitir. Fica registado aqui porque é a peça com mais risco de estar
subtilmente errada, e essa parte está agora verificada.

Como se verificou sem tocar na AT: gerei um par de chaves, dei a metade pública ao código
e usei a privada para **desfazer** o que ele produziu — exatamente como a AT faria. A senha
volta ao original com acentos e tudo, a data volta em UTC, e em 200 pedidos saíram 200
chaves diferentes, como a AT exige.

## 1.29.0 — 2026-08-06

**Moradas em partes, e numeração de documentos de transporte.** Segundo passo para a
comunicação à AT — ainda não comunica nada, prepara o que ela exige.

**A ficha de fornecedor ganhou código postal, localidade e país.** A AT não aceita a morada
num bloco só: quer morada, código postal, localidade e país em campos separados, e os quatro
são **obrigatórios no remetente**. O que já lá tinhas fica como a linha da morada; falta
preencher os outros.

Não parti a morada existente automaticamente. Adivinhar onde acaba o código postal funciona
nos exemplos e falha no vigésimo caso real — e um endereço mal partido num documento legal é
pior do que um campo por preencher.

**O documento de acompanhamento passa a dizer o que falta.** Já avisava de NIF e morada em
falta; agora também de código postal e localidade do remetente. É assim que se corrige antes
de interessar, em vez de aparecer como comunicação recusada mais tarde.

**Numeração por série.** Em ⚙ há agora uma série de documentos (por omissão, o ano) e cada um
dos cinco tipos da AT — GR, GT, GA, GC e GD — tem o seu contador próprio, no formato que o
SAF-T exige: `GT 2026/7`.

Dois cuidados que valem a pena saber:

- **Um número só é gasto quando um documento é mesmo emitido.** A maior parte do material
  sai daqui sem nunca ser documento comunicado; numerar cada envio deixaria buracos na série.
- **Não se pode voltar a uma série que já emitiu documentos**, e uma importação de dados
  nunca faz o contador recuar. Entre repetir um número e saltar um, salta-se — repetir é o
  erro que não tem emenda.

## 1.28.0 — 2026-08-06

**Credenciais do Portal das Finanças, uma por pessoa.** Primeiro passo para os documentos
de transporte serem comunicados à AT a partir da aplicação.

Na tua ficha (clica no teu nome, canto superior direito) há uma secção nova, **Comunicação
à AT**, com o utilizador do Portal no formato `NIF/subutilizador` e a respetiva senha. O
ecrã diz-te sempre se a conta está em condições de comunicar ou não.

**Cada pessoa mete as suas.** Um administrador vê **quem** pode comunicar, mas não vê nem
define a senha de mais ninguém — não há caminho nenhum na aplicação para isso. É o que a
própria AT determina: as credenciais são de quem responde pelo envio.

**Quem não as tiver preenchidas não comunica automaticamente.** Nada mais muda para essa
conta: continua a criar envios, a imprimir e a enviar por e-mail como sempre.

**A senha é guardada cifrada** e nunca mais sai do servidor — nem para o teu próprio
browser. Deixar o campo em branco ao gravar mantém a que já lá está, em vez de a apagar.

> **Nota para a instalação:** é preciso definir a variável `TWINFLOW_AT_KEY` no servidor
> (32 bytes, em hexadecimal ou base64) para as credenciais poderem ser guardadas. Sem ela a
> aplicação **recusa gravar** em vez de guardar a senha em claro. A ligação à AT em si —
> endereço, ambiente e certificados — fica num ficheiro à parte, fora da pasta pública,
> apontado por `TWINFLOW_AT_CONFIG`; enquanto não existir, assume-se sempre o ambiente de
> **testes**, nunca o de produção.

## 1.27.1 — 2026-08-06

**Três correções da revisão de código. Todas eram silenciosas — é isso que as torna sérias.**

**Um pedido criado sem rede deixa de se perder.** A aplicação dizia «Pedido PR-0007 criado»
mesmo quando o servidor não tinha recebido nada, e minutos depois o pedido desaparecia do
ecrã sozinho, na sincronização seguinte. Havia dois casos diferentes escondidos atrás da
mesma mensagem:

- **O servidor recusou** (sem acesso ao projeto, ou ainda a arrancar). Agora a janela fica
  aberta com o que escreveste e diz-te o motivo. Nada é guardado — porque nada foi criado.
- **Não havia rede.** O pedido fica guardado no dispositivo e **numa fila**, e a mensagem
  diz isso: *«guardado neste dispositivo — será criado quando houver ligação»*. Quando a rede
  volta, é enviado sozinho e passa a ter o número definitivo do servidor. Deixa de
  desaparecer quando entretanto sincronizares.

**Reimportar a folha deixa de apagar o que classificaste à mão.** O tipo voltava a vazio e a
unidade voltava a `un` em cada reimportação, porque a folha não diz nada sobre nenhum dos dois
e o leitor assumia `un` para qualquer célula com um número simples. **A unidade era a pior**:
mudava o significado de todas as quantidades guardadas dessa referência.

Agora a folha **preenche mas não substitui**: o tipo só entra se a folha o souber resolver e
a referência ainda não tiver um; a unidade só muda se a célula disser mesmo a unidade
(`700m`). O que classificaste fica.

**Importar dados deixa de reabrir migrações já feitas.** Uma importação de estado completo
limpava as marcas de migração desta instalação e, no reinício seguinte, um diretor de projeto
a quem tivesses restringido os projetos **voltava a ter acesso a todos**. As marcas passam a
sobreviver à importação. Em contrapartida, os dados importados são convertidos **na hora** —
antes ficavam a meio até alguém reiniciar o servidor, e uma importação de folha nessa janela
duplicava o armazém inteiro.

## 1.27.0 — 2026-08-06

**Encomendar direto a partir do que está em falta.** Deixa de ser preciso ir à aba das
compras e procurar a referência numa lista de 119.

- Na tabela de **Saldos**, uma referência abaixo do mínimo passa a ter **🛒 Encomendar** ao
  lado das outras ações. Abre a encomenda já com essa referência e com a quantidade que falta
  para chegar ao mínimo sugerida.
- No quadro de **necessidades**, as linhas em falta ganham o mesmo botão — mas **só quando o
  armazém também não consegue cobrir**. Se o armazém tem, o que se faz é enviar, e o botão de
  encomendar não aparece para não sugerir uma falta que não existe. A quantidade sugerida é
  só a parte que o armazém não cobre.

Em ambos os casos a quantidade fica editável: é uma sugestão, não uma ordem, e quase ninguém
encomenda exatamente o mínimo.

**Os documentos passam a gerar PDF em vez de abrir a impressão.** A guia de acompanhamento e
a nota de encomenda têm agora **⬇ Descarregar PDF**. Ficas com um ficheiro — que podes anexar
a um e-mail, guardar na obra ou arquivar — em vez de uma caixa de impressão. **No telemóvel é
a diferença entre funcionar e não funcionar**: «imprimir» num iPhone não leva a lado nenhum,
descarregar abre o menu de partilha.

O PDF é gerado dentro da própria aplicação, sem bibliotecas de terceiros e sem nada instalado
no servidor — funciona na mesma **sem rede**. O aviso de que a guia é um documento interno,
não comunicado à AT, vai dentro do PDF e não só no ecrã: quem recebe o papel é o motorista,
não quem o mandou fazer.

## 1.26.0 — 2026-08-05

**Uma encomenda passa a ter várias referências, e cada uma é recebida quando chegar.**
Antes, uma encomenda era uma referência: cinco artigos ao mesmo fornecedor obrigavam a cinco
encomendas, e não havia forma de registar que o fornecedor entregou três e ficou a dever duas.
Era a funcionalidade a meio, e é isso que fica corrigido.

**Ao criar a encomenda**, escolhes o fornecedor uma vez e acrescentas as linhas que quiseres
com **+ Linha**. Uma referência já usada deixa de aparecer nas linhas seguintes, para não a
encomendares duas vezes por engano.

**Se a referência ainda não existir**, tens **+ Referência nova** ali mesmo. Abre a ficha
completa de sempre — com o aviso de referências parecidas e a recusa de duplicados — e, ao
gravar, a referência entra sozinha na linha e voltas à encomenda sem perder o que já tinhas
escrito.

**Receber é por linha.** Cada linha tem o seu botão **Receber**, e podes receber **só parte**:
se encomendaste 100 e chegaram 40, registas 40 e a linha continua a dever 60. Sugere sempre o
que falta, portanto o caso normal continua a ser um clique. Cada receção lança a sua entrada
em armazém no momento em que acontece.

**Um estado novo: Parcial.** A encomenda fica *Parcial* enquanto houver algo em falta e só
passa a *Entregue* quando a última linha entrar. O estado é **calculado a partir das linhas** —
deixa de haver forma de o cabeçalho dizer «entregue» com uma linha por receber.

**Nota de encomenda para imprimir.** O botão 🧾 abre o documento com as três colunas que
interessam — encomendado, recebido e **em falta** — e imprimes para PDF pelo navegador. É a
folha para andar atrás do que não chegou.

**Não podes eliminar uma encomenda que já recebeu bens** — antes só bloqueava as que estavam
totalmente entregues, e uma encomenda parcial podia desaparecer deixando as entradas no
armazém a apontar para nada. Corrige-se com um acerto de stock, como sempre.

**As encomendas que já tinhas passam a encomendas de uma linha**, sozinhas, sem perderes nada.
As que estavam entregues aparecem com a linha já recebida — não voltam a pedir entrada, que
duplicaria o stock.

## 1.25.0 — 2026-08-05

**Botão Ø na ficha do componente.** O símbolo de diâmetro não existe no teclado português e
faz falta em metade dos descritores (VARÃO Ø20, TUBO Ø200). Ao criar ou editar um componente
há agora um botão **Ø** no topo da ficha.

**Escreve no campo onde estiveres**, na posição do cursor — como se fosse uma tecla. Clicas
no meio de «VARAO 20», carregas no Ø e ficas com «VARAO Ø20» com o cursor logo a seguir ao
símbolo. Se tiveres texto selecionado, substitui-o. Funciona no nome, na referência, na
medida, na norma, na marca e na localização.

Se estiveres num campo que não é de texto (o tipo ou a unidade), o símbolo vai para o último
campo de texto onde escreveste, em vez de se perder.

## 1.24.2 — 2026-08-05

**O modelo 3D deixa de ter zonas às escuras.** Havia uma única luz forte vinda de cima à
direita, e o «chão» da luz ambiente era quase preto — portanto tudo o que estivesse virado
para o lado contrário, e sobretudo **o que se vê por baixo** (a face inferior de uma laje, a
barriga de uma viga), aparecia como uma mancha escura sem forma. Num visualizador em que
andas à volta do modelo, metade do que olhavas estava desse lado.

Passam a existir quatro luzes: a principal como antes, uma de enchimento do lado oposto, uma
fraca de baixo para cima, e uma pequena presa à câmara — essa faz com que **o que tens virado
para ti esteja sempre iluminado**, independentemente de como rodaste o modelo.

**As cores de estado continuam a ler-se na mesma.** A luz não foi aumentada em força: foi
espalhada por mais direções. Medido: a face inferior de uma laje passou de praticamente preta
para claramente legível, enquanto as superfícies que já estavam bem iluminadas subiram menos
de 10% e nada ficou queimado — o verde e o vermelho mantêm a mesma relação entre si.

## 1.24.1 — 2026-08-05

**A guia deixa de incluir linhas estornadas.** Se estornares uma linha de uma carga — porque
foi a referência errada ou a quantidade errada — e depois reimprimires o documento pelo 🧾,
essa linha aparecia na mesma, pela quantidade inteira. O mesmo acontecia no documento
**enviado por e-mail**, que é composto no servidor: podia sair para o destino um papel a
declarar bens que não seguiram.

Um estorno é a correção de um engano, não mercadoria que viajou. O documento é reconstruído a
partir do livro de movimentos, e o livro já risca essas linhas — agora o papel também. Se uma
carga tiver sido estornada por inteiro, a aplicação diz-te isso em vez de abrir um documento
vazio, e o envio por e-mail é recusado com a mesma explicação.

## 1.24.0 — 2026-08-05

**Os quatro pontos de segurança que faltavam da revisão.** Um deles muda a forma de
trabalhar e está explicado primeiro.

**⚠ Uma conta que ainda tenha a palavra-passe de origem passa a ser obrigada a mudá-la.**
Ao entrar, aparece um ecrã que só deixa fazer duas coisas: definir uma palavra-passe nova
(mínimo 8 caracteres) ou terminar sessão. Não há botão de fechar, e o servidor recusa tudo
o resto até a mudança estar feita.

Antes disto era um aviso que se fechava com um clique — e o servidor nunca verificava nada.
Quem entrasse com `admin`/`admin` tinha poderes completos de administrador desde o primeiro
pedido: contas, importação de dados, exportação do registo de decisões, tudo. **Depois de
instalares esta versão, qualquer conta nesse estado tem de definir a palavra-passe antes de
poder trabalhar.** Se for a tua conta de administrador, faz isso primeiro.

**O correio deixa de poder ir para qualquer lado.** O envio de e-mail pela aplicação aceitava
destinatário e texto livres. Como o correio sai autenticado pelo domínio da empresa, leva a
credibilidade toda de um e-mail teu — e o perfil mais baixo com acesso a isso é o encarregado,
uma conta que anda em telemóveis partilhados na obra. Passa a só se poder escrever a **um
fornecedor da lista ou a um colega com conta**. O envio do pedido ao fornecedor e a guia
continuam iguais. Cada envio fica agora **registado em ⚙ Atividade**; antes não deixava rasto
nenhum dentro da aplicação.

**A ficha da própria empresa e o tipo de um fornecedor passam a ser do administrador.** O
`p-gc` é o remetente impresso em cada guia com NIF e morada, e o e-mail de uma entidade de
fabrico é para onde a guia **é enviada**. Qualquer diretor — encarregado incluído — podia
reescrever essas fichas e apontar os documentos para outro endereço, e no ecrã só mudava a
coluna do contacto. Continuam todos a poder **manter os contactos** de um fornecedor; mudar
**o que uma entidade é**, ou mexer na ficha da empresa, é agora ato de administrador. E uma
alteração de e-mail, NIF ou morada passa a ficar registada com o valor **antes e depois** —
antes o registo só dizia «tem e-mail», que era verdade antes e depois de um desvio.

**Ligar uma conta de qualidade ou logística a um sítio passa a estreitá-la mesmo.** A ligação
já estreitava tudo o que essas contas escrevem, mas na leitura não fazia nada: recebiam o
saldo de todas as fábricas e o livro de movimentos inteiro. Se ligaste uma conta dessas a
uma entidade a pensar que a limitavas, agora limita.

## 1.23.2 — 2026-08-05

**Duas correções de segurança saídas da revisão de código.** Nenhuma muda o que a aplicação
faz; ambas fecham caminhos por onde um registo podia ser adulterado.

**O histórico de um pedido deixou de poder ser apagado.** Ao gravar um pedido, o servidor
aceitava a versão que o cliente lhe mandasse — inteira. Todas as verificações que lá
estavam olhavam para a frente: um estado desconhecido, um perfil que não pode fazer aquela
transição, o número de não conformidades validadas a **subir**. Nenhuma olhava para trás.
Quem tivesse conta com acesso ao projeto — a fábrica, e também qualidade e logística, que
chegam a todos os projetos — podia regravar o pedido sem as não conformidades e com o
registo de acontecimentos aparado. Desaparecia a não conformidade **e o rasto de que
alguma vez existiu**.

A partir de agora o servidor é o dono desses três registos — acontecimentos, não
conformidades e inspeções. O que está guardado é a base: o que o teu dispositivo trouxer a
mais é acrescentado, o que trouxer a menos é ignorado. Uma não conformidade continua a
mudar de estado (aberta → reparada → validada), mas quem a levantou e quando já não se
reescrevem, e nenhuma desaparece. As gravações feitas sem rede continuam a passar — é
precisamente por trazerem uma lista mais antiga que isto é uma junção e não uma recusa.

**O tipo de um fornecedor passou a ser uma lista fechada, também do lado do servidor.** O
ecrã ⚙ → Fornecedores só oferece cinco opções, mas o servidor guardava o que lhe
chegasse, e depois a tabela imprimia esse texto tal e qual. Um tipo escrito com marcação de
página tornava-se código a correr no navegador de quem abrisse aquele ecrã — administrador
incluído. O servidor passa a construir a ficha campo a campo e a recusar qualquer tipo fora
dos cinco; o ecrã escapa o texto que imprime. Nada do que tens registado muda.

**Precisava de uma conta válida nos dois casos**, portanto não era uma porta aberta à
Internet como a da 1.23.1 — era uma conta legítima a poder fazer mais do que devia.

## 1.23.1 — 2026-08-05

**Correção de segurança grave** na proteção dos ficheiros que nunca podem ser servidos,
encontrada em auditoria interna. **Uma instalação atrás de um alojamento partilhado não
estava exposta** — o servidor da frente recusava os pedidos em causa antes de chegarem à
aplicação, e a base de dados está fora da pasta pública; o problema afetava quem corre a
aplicação diretamente em Node, como acontece em desenvolvimento.

Corrigido na origem: o caminho passa a ser **resolvido primeiro e verificado depois**,
portanto qualquer forma de escrever um endereço que dê no mesmo ficheiro é tratada como
esse ficheiro. As tentativas usadas na auditoria ficaram registadas internamente para
serem repetidas em revisões futuras.

## 1.23.0 — 2026-08-05

**Menos filtros, e os que ficam dizem-te alguma coisa.** Os Saldos tinham seis caixas de
filtro; passam a quatro. Os Movimentos tinham quatro; passam a duas.

**As vistas deixaram de ser uma caixa e passaram a fichas com o número à frente.** Em vez
de abrires uma lista e experimentares «Saldos negativos» para descobrir que não há nenhum,
vês logo `Com stock em fábrica 7` e clicas se quiseres. Clicas outra vez e limpa.

**As fichas que não têm nada para mostrar não aparecem** — exceto **⚠ Abaixo do mínimo**,
que se mostra sempre, a zero e em cinzento: ali o zero é a resposta que interessa («não
falta nada»), e não ruído.

**O filtro de Unidade só aparece quando houver mais do que uma unidade** no armazém. Hoje
tens tudo em unidades, portanto desaparece; volta sozinho no dia em que tiveres metros.
A mesma regra vale nos Movimentos para os filtros de projeto e de fábrica.

**Nos Movimentos, a lista de 119 componentes desapareceu.** A pesquisa já encontra por nome,
medida, palete ou marca desde a 1.17.0. Quando saltas do histórico 🕐 de uma referência,
aparece uma ficha *«Só: PARAFUSO M20X40 ✕»* que limpas com um clique — preciso quando é
usado, invisível quando não é.

Nada do que filtravas deixou de se poder filtrar.

## 1.22.0 — 2026-08-05

**A guia pode seguir por e-mail para o destino.** No documento de acompanhamento — o que
aparece ao confirmar uma carga e o que reabres pelo 🧾 no histórico — há agora um botão
**✉ Enviar por e-mail**, ao lado de Imprimir.

**Só sai com o teu clique.** Não há caixa pré-marcada nem envio automático ao confirmar a
carga: confirmar o envio e mandar o papel são dois atos separados, de propósito.

O botão só aparece quando a entidade de destino tem e-mail na ficha; se não tiver, a
aplicação diz-te qual falta em vez de falhar sem explicação. O e-mail leva remetente e
destinatário com NIF e morada, hora de início, matrícula e a lista de bens — e leva o mesmo
aviso do documento: **é interno, não foi comunicado à AT e não substitui a guia legal**.

Fica registado quem enviou e para onde, e conta para o limite de e-mails por hora que já
existia.

## 1.21.1 — 2026-08-05

**Correção de segurança — saldos que não deviam sair do servidor.** Uma conta ligada a uma
fábrica ou obra recebe, no ecrã de stock, apenas o saldo do seu sítio: o saldo de armazém e
o das outras fábricas nunca lhe são enviados. Mas quando essa conta **registava** um
consumo ou um estorno, a resposta do servidor trazia o componente inteiro — com o saldo de
armazém verdadeiro e o de todas as fábricas — e a aplicação guardava-o. Bastava marcar um
consumo para ver o que a filtragem existe para esconder.

A máscara passa a estar num sítio só e todas as saídas usam a mesma. Encontrado numa
revisão ao código; a versão 1.16.0, que introduziu a filtragem, foi testada só na leitura.

**Correção — a obra via o botão de estorno e levava erro.** O consumo em obra (1.21.0)
abriu as marcações à equipa de obra mas não os estornos, e o botão aparecia na mesma.
Agora a equipa pode anular a sua própria marcação — e só a sua.

**Correção — conta de obra sem obra atribuída podia registar consumos em qualquer lado.**
Não via stock nenhum, como está previsto, mas na escrita passava. Agora não vê nem escreve,
que era a regra desde o início.

## 1.21.0 — 2026-08-05

**Devolver sobras ao armazém.** Nos Saldos, as referências que têm stock fora do armazém
ganham um botão **↩ Devolver**: escolhes de onde vem, quanto, e o material volta. É um tipo
de movimento próprio — «voltaram 12 da fábrica» fica escrito assim no histórico, em vez de
dois acertos que ninguém sabe explicar daqui a três meses. Não deixa devolver mais do que
lá está, e o estorno devolve à fábrica.

**Consumir material que está em obra.** A equipa de obra passa a poder registar o que
aplicou, estragou ou perdeu — como a fábrica já fazia. Para isso, a conta tem de estar
**ligada a uma obra** em ⚙ Configuração → Utilizadores; a partir daí vê só o stock dessa
obra e não mexe em mais nada. Antes, o material entregue em obra entrava no saldo e nunca
mais saía de lá.

**Reimprimir a guia de uma carga antiga.** No histórico de Movimentos, cada envio tem um
botão 🧾 que reabre o documento dessa carga, com a matrícula e a hora originais.

**O encarregado passa a ter as mesmas permissões do diretor de projeto** — a teu pedido, por
ser um cargo de chefia. Cria e apaga pedidos, gere projetos, fornecedores, componentes e
encomendas, vê todos os projetos, e **valida não conformidades e desenhos de fabrico**.

Fica registado que isto junta na mesma pessoa a marcação de uma não conformidade como
reparada e a sua validação. Foi uma decisão tua, tomada com o aviso à frente.

## 1.20.0 — 2026-08-05

**O stock passa a poder ser enviado para obra, não só para fábrica.** No envio escolhes o
destino entre as empresas de fabrico **e** as equipas de obra, e o saldo fica registado
nesse destino como já ficava nas fábricas.

**As entidades ganham NIF e morada** (⚙ Configuração → Fornecedores), porque são os dados
que um documento de transporte obriga a ter.

**E o envio gera um documento de acompanhamento.** Ao confirmar uma carga aparece um
documento pronto a imprimir com remetente, destinatário, NIF e moradas dos dois, data e
hora de início do transporte, matrícula do veículo e a lista de bens com quantidades. O
botão Imprimir usa a impressão do browser — dá para guardar em PDF.

**Lê o aviso no topo do documento, porque é a sério:** isto é um **documento interno**.
**Não** é comunicado à AT e **não** substitui a guia de transporte legalmente exigida. Serve
para o material seguir acompanhado de um papel com os dados certos e para deixar de haver
transcrições à mão — não para cumprir a obrigação fiscal.

Se faltar o NIF ou a morada de alguma das partes, o documento diz o que falta e onde
preencher, em vez de sair com campos vazios.

## 1.19.0 — 2026-08-05

**O Tipo passa a ser uma lista de três, com a definição à mão.** Deixa de ser texto livre:

- **Material** — tudo o que fica incorporado na obra (tubo, cabo, caixas, aparelhagem…)
- **Equipamento** — ferramentas e máquinas reutilizáveis (martelo elétrico, berbequim,
  escada, andaime…)
- **Consumível** — gasta-se a aplicar (buchas, fita isoladora, brocas, discos, parafusos)

Ao lado do campo há um **ⓘ**: passa o rato e aparecem as três definições. Está também no
filtro dos Saldos e em cada etiqueta da tabela, porque a dúvida "isto é material ou
consumível?" aparece na altura de escolher, não antes.

**Os 16 valores antigos foram convertidos** no arranque desta versão: FIXAÇÃO, SOLDA,
SELANTE, ESPUMA e as fitas passaram a **Consumível** (63); CALÇOS, TUBO, VARÃO, MEMBRANA,
ISOLAMENTO e ESTRUTURA MADEIRA a **Material** (11); COFRAGEM a **Equipamento** (1). As 44
referências que nunca tiveram tipo ficam **por classificar** — e há um filtro
«Por classificar» para as encontrares e ires acertando.

O que a folha de cálculo trouxer no futuro passa pela mesma tabela de conversão, portanto
uma importação nova fica classificada da mesma maneira.

## 1.18.0 — 2026-08-05

**Ao criar um componente, a aplicação diz-te se ele já existe.** Enquanto escreves o nome
aparecem por baixo as referências parecidas que já estão no armazém, com medida, palete e
saldo — e um clique abre a que já existe em vez de criares outra. Ignora maiúsculas,
acentos e espaços, por isso «parafuso m20x40» encontra «PARAFUSO M20X40».

**E recusa a repetição exata:** duas referências com o mesmo **nome, medida e localização**
são a mesma coisa introduzida duas vezes, e isso passa a ser impedido. A aplicação diz com
qual é que chocou e oferece abri-la.

**Só a repetição exata é impedida**, de propósito. No teu armazém há quatro grupos com o
mesmo nome que se distinguem pela medida (as chapas de pilar de arranque) e uma referência
que vive legitimamente em duas paletes — uma regra sobre o nome ou sobre a referência
sozinhos recusaria dados verdadeiros. Uma referência repetida dá aviso, não bloqueio.

**Porque é que isto interessa:** um componente duplicado divide o saldo por dois registos, a
pergunta "quanto é que temos?" passa a ter a resposta errada, e não há como corrigir depois
— assim que o duplicado leva uma entrada, já não pode ser apagado. Fica só arquivar um e
viver com o saldo partido. Vale mais impedir do que remediar.

É a mesma identidade que a importação já usava, portanto uma referência escrita à mão passa
a ser reconhecida quando a mesma linha chegar numa folha de cálculo — em vez de entrar
outra vez pela outra porta.

## 1.17.0 — 2026-08-05

**Um só botão Enviar, com vários componentes de uma vez.** O botão Enviar de cada linha
desapareceu. Em Stock → Saldos há agora **um** botão Enviar: escolhes a fábrica uma vez,
escreves as quantidades nas referências que quiseres — com pesquisa, porque são 119 — e
envias tudo num só ato.

Ao lado de cada referência aparece o saldo de armazém, e uma quantidade acima do saldo é
assinalada enquanto escreves. **Ou entra tudo, ou não entra nada:** se uma linha pedir mais
do que existe, não se envia nada e a aplicação diz qual é a linha. Uma remessa a meio
registada era o pior resultado possível — o livro dizia uma coisa e o camião outra.

As quantidades que escreves ficam guardadas enquanto pesquisas, por isso podes ir buscando
referências por partes sem perder o que já tinhas escrito. Cada linha continua a ser um
movimento próprio no histórico, com a mesma data e a mesma nota.

O botão "enviar em falta" das Necessidades abre a mesma folha, já com essa linha preenchida.

**Entrada e Ajuste continuam por linha** — são atos de um componente de cada vez.

**Quando não há nenhuma fábrica registada, a aplicação passa a dizê-lo.** O campo Fábrica na
ficha de utilizador mostrava uma lista vazia, o que se lia como "ainda não está feito". Passa
a explicar que falta criar uma empresa do tipo Fábrica em ⚙ Configuração → Fornecedores —
sem isso não há stock de fábrica nem para onde enviar.

## 1.16.0 — 2026-08-05

**Cada referência passa a ter um nome só.** A descrição curta e a descrição eram dois campos
que na folha diziam quase sempre o mesmo. Passam a ser um. Onde a folha repetia, o nome fica
igual; onde dizia coisas diferentes, ficam as duas — porque em algumas referências é a
segunda metade que as distingue (seis chapas de pilar com o mesmo nome e a mesma palete, só
o furo as separa).

**Isto altera nomes que já estavam gravados** — 50 das 119 no arranque desta versão. É feito
uma vez, automaticamente, e refaz também a identidade que a importação usa para reconhecer
cada linha; sem isso, a importação seguinte da mesma folha não reconheceria nenhuma
referência e criaria o armazém todo outra vez.

**Uma conta pode agora pertencer a uma fábrica**, ao lado dos projetos que já tinha
(⚙ Configuração → Utilizadores). Quem tem essa ligação **vê e mexe apenas no stock da sua
fábrica**: não recebe o saldo de armazém, não recebe o saldo das outras fábricas, vê só os
movimentos da sua, e só pode registar consumo, defeito ou perda na sua. A filtragem é feita
no servidor — o que a conta não pode ver não chega sequer ao aparelho.

Quem gere o armazém — administrador, diretor de projeto e diretor de obra — não é afetado.

**Atenção ao instalar:** uma conta de fábrica **sem** fábrica atribuída deixa de ver stock
nenhum, de propósito. Depois de reiniciar, liga a conta da fábrica em ⚙ Configuração →
Utilizadores, ou ela fica sem stock à frente.

## 1.15.0 — 2026-08-04

**Arquivar uma referência que já não se usa.** Um componente com movimentos não pode ser
apagado — o histórico ficaria a apontar para uma coisa que não existe. Depois da importação
do armazém isso passou a ser quase tudo: 116 das 119 referências têm um movimento desde o
primeiro minuto, porque o saldo inicial entra como entrada a sério.

Arquivar é a saída. A referência sai das listas, deixa de ser oferecida em encomendas,
receitas e movimentos, e deixa de contar para os avisos de stock mínimo. **O histórico fica
intacto** — os movimentos continuam todos lá e continuam a poder ser procurados. Reversível
a qualquer momento, e há um filtro **Arquivados** para as ver.

Pode arquivar-se uma referência que ainda tem stock — um armazém deixa mesmo de usar coisas
de que ainda tem sobras — mas nesse caso a aplicação diz quanto é que lá está antes de
confirmar. Uma reimportação da folha **não desarquiva nada**: quem arquivou foi uma pessoa.

**A pesquisa em Movimentos passa a encontrar pelo componente.** Antes só procurava na nota,
no código do pedido e em quem fez o movimento — procurar "PARAFUSO" ou "PALETE 07" no
histórico não dava nada, porque um movimento guarda só o identificador e as palavras que
conhecemos estão na ficha do componente. Agora procura no nome, referência, descrição, tipo,
medida, norma, marca e localização, e também na fábrica, no projeto e no tipo de movimento.

**O filtro de fábricas passa a incluir o armazém.** Respondia a "onde está o stock" mas só
sabia falar de fábricas. Ganhou **Em armazém**, e a opção de topo passou a chamar-se
**Em qualquer sítio**, que é o que sempre quis dizer.

## 1.14.1 — 2026-08-04

**Correção — o servidor entregava dois dos seus próprios ficheiros de código.** A lista do
que nunca pode ser servido nomeava o `serve.mjs` e o `db.mjs` um a um. Todos os módulos de
servidor escritos depois disso nasciam legíveis: o `train-log.mjs` desde a 1.7.0 e o
`xlsx-stock.mjs` desde ontem. Passa a bloquear pela extensão `.mjs`, portanto um módulo novo
fica protegido no momento em que é criado.

**Em produção não houve exposição.** O `.htaccess` já negava todos os `.mjs` antes de o
pedido chegar ao Node — confirmado. Isto fechava a diferença entre as duas listas, que é o
que costuma acabar mal: duas defesas para a mesma coisa, e só uma a trabalhar.

Nada do que o browser precisa é `.mjs` — a aplicação do lado do cliente é toda `.js` —
por isso a mudança não afeta o que é carregado. O `manifest.json` continua a ser servido.

## 1.14.0 — 2026-08-03

**O armazém passa a saber onde estão as coisas.** Cada componente ganha seis campos que
antes não tinham onde ficar: descrição, tipo, medida, norma, marca e **localização**. A
localização é a que faltava mais: um armazém com 119 referências em 30 paletes não se
usa sem saber em que palete está cada uma.

Nos Saldos há agora colunas de tipo, medida e localização, filtros por tipo e por palete,
ordenação por localização, e a pesquisa passou a procurar em todos estes campos — quem
procura "ROTHOBLAAS" ou "M20X40" não tem de saber em que coluna isso vive. O CSV leva-os
todos.

**Importar o inventário a partir de uma folha de cálculo (só administrador).** Em Stock →
Saldos, o botão **Importar armazém** lê um `.xlsx` e carrega as referências de uma vez.

Mostra sempre primeiro o que percebeu da folha — quantas referências novas, quantas já
existem, quantas unidades vão entrar, e nomeia as linhas de que não conseguiu tirar
quantidade. **Nada é gravado enquanto não confirmares.**

Duas regras que vale a pena conhecer:
- As quantidades iniciais entram como **movimentos de entrada** reais, não como um número
  posto à mão. Todas as unidades do armazém ficam explicadas por qualquer coisa que
  aconteceu.
- Voltar a importar a mesma folha **não duplica nem soma**: as referências que já existem
  só atualizam a descrição. Quem manda nos saldos é o histórico de movimentos, não a folha.

**Correção — repor os dados não ficava reposto.** Se algum aparelho ainda tivesse a versão
antiga guardada, bastava abrir a aplicação nesse aparelho para tudo voltar: o programa via
o servidor vazio, concluía que era uma instalação antiga por migrar, e reenviava tudo. A
reposição fica agora marcada no servidor e mais nenhum aparelho a desfaz. **Isto importa
para o dia em que apagares os dados de teste antes do arranque a sério.**

**Correção — o aviso de reposição estava incompleto.** Dizia que apagava projetos, ficheiros
IFC, pedidos e fornecedores. Apagava também o armazém inteiro e as encomendas, sem o dizer.

## 1.13.1 — 2026-08-02

**A aplicação sincroniza ao voltar ao ecrã.** No telemóvel, com a app instalada, o iOS
suspende os temporizadores e corta a ligação permanente ao servidor enquanto ela está em
segundo plano. Ao reabrir, ficavas a ver o estado de quando saíste até à sondagem seguinte
— até um minuto. Se agisses nesse intervalo, o pedido seguia com a versão antiga e o
servidor recusava, com a mensagem *"Outra pessoa alterou este pedido primeiro"*, mesmo
quando não havia outra pessoa nenhuma: era só o relógio.

Passa a atualizar assim que a app volta a ficar visível, e também quando a rede regressa.

Isto **não substitui** a proteção contra escritas simultâneas — duas pessoas podem mesmo
agir ao mesmo segundo, e nesse caso a recusa continua a ser o comportamento certo. Tira do
caminho o caso em que o único "outro" era o tempo passado em segundo plano.

## 1.13.0 — 2026-08-02

**A aplicação instala-se no telemóvel e abre sem rede.** Passa a haver ícone no ecrã
inicial, abre sem a barra do browser, e uma pressão longa no ícone leva direto a
**Digitalizar** ou a **Pedidos de Produção**.

**Sem rede, abre à mesma** — com o último estado que aquele aparelho viu, e com um aviso
permanente no topo a dizê-lo. O aviso fica enquanto o servidor não responder e desaparece
assim que alguma coisa lá chegar; não é uma mensagem que passa em quatro segundos, porque
o que ela diz continua verdade enquanto os dados no ecrã forem os antigos.

**O código é sempre procurado na rede primeiro.** A cache só entra quando não há sinal.
Isto é deliberado: uma aplicação instalada que prefere a cache fica com código velho preso
no telemóvel, e um deploy passa a ser uma lotaria — já aconteceu aqui uma vez, com um
`store.js` em cache a importar dados sem o campo das encomendas. Com rede, o
comportamento é exatamente o de hoje: a atualização chega no carregamento seguinte.

**Uma correção que veio ao de cima ao testar isto:** perder o sinal **terminava a sessão**.
Qualquer falha ao confirmar a conta era tratada como "sessão inválida" — apagava a marca de
sessão e mandava para o ecrã de entrada, e ficava assim mesmo depois de a rede voltar.
Agora só um "não autenticado" vindo do servidor termina a sessão; falta de rede mantém-na.
Sair da conta continua a limpar tudo, incluindo a cópia que o aparelho guarda para
abrir sem rede.

Nada de dados de conta é guardado na cache do service worker — só o código. E o pacote de
instalação não inclui o motor 3D: são 6,4 MB que continuam a ser carregados só quando
abres o modelo.

## 1.12.0 — 2026-08-02

**Os alertas de stock passam a fazer parte do resumo diário.** Deixam de ser dois e-mails
próprios: quem está atrasado em três pedidos e com falta de um componente recebe isso
**junto, uma vez**, em vez de três remetentes a chegar a horas diferentes da mesma manhã.

As duas secções — armazém e fábrica — aparecem no resumo de quem pode agir sobre elas
(administrador, diretor de projeto, diretor de obra) e desaparecem quando não há falta
nenhuma. O conteúdo é o mesmo de antes; muda o embrulho.

Como consequência, os dois relógios separados desapareceram: havia um contador de 22 horas
por cada alerta, e agora a cadência é a do resumo — uma vez por dia, a partir da hora
definida.

**A hora do resumo passa a ser configurável** com `TWINFLOW_DIGEST_HOUR` (0–23, por omissão
7). A hora certa é aquela a que o e-mail é lido antes da reunião de obra, e isso não é
decisão do código.

## 1.11.0 — 2026-08-01

**Resumo diário, um por pessoa, só com o que lhe toca.** A alternativa era mais um alerta
por tema — e é assim que a automação morre: cinco remetentes a disputar a mesma caixa de
entrada até alguém criar um filtro. Passa a ser **um e-mail por dia por conta**, com o que
está à espera *daquela* pessoa, e **não é enviado de todo quando não há nada**.

Cada perfil vê o que pode resolver:

- **Direção** (admin, diretor de projeto, diretor de obra) — pedidos em atraso e cargas por
  confirmar, que bloqueiam o despacho seguinte. O diretor de projeto e o administrador veem
  ainda os desenhos de fabrico à espera de validação; a direção de obra, as não
  conformidades reparadas à espera de assinatura.
- **Fábrica** — pedidos à espera de aceitação, o que está em produção, e desenhos por
  submeter.
- **Logística e encarregado** — prontos para despacho e cargas por confirmar entrega.
- **Obra** — entregues à espera de montagem.
- **Qualidade** — não conformidades em aberto e pedidos prontos, à espera da inspeção de
  saída de fábrica.

Detalhes que interessam: sai **a partir das 07:00 de Lisboa**, calculado com fuso explícito
para não depender da hora do servidor; respeita o âmbito de projetos de cada conta, por isso
ninguém vê obra que não é sua; e **quem não tiver e-mail na conta não recebe** — é essa a
forma de não receber. O modo de teste do e-mail passa a escrever no log o que teria enviado,
para se poder conferir sem mandar nada.

## 1.10.0 — 2026-08-01

**Stock mínimo por fábrica, com alerta próprio.** Até agora só o armazém tinha mínimo. Cada
componente passa a poder ter também um mínimo **para cada fábrica**, definido na ficha do
componente, e quando o saldo numa fábrica cai abaixo desse valor sai um **e-mail separado**
do de armazém.

São dois alertas distintos de propósito: uma falta em armazém é um problema de compras, uma
falta numa fábrica é um problema de expedição, e são tratadas por pessoas diferentes em
momentos diferentes. Cada um tem o seu próprio relógio, por isso um sair nunca cala o outro
nesse dia — e ambos mantêm a regra de no máximo um por dia.

- **Deixar em branco não avisa.** Em branco e zero são coisas diferentes: só o zero avisa
  (sempre que o saldo ficar abaixo de zero). Sem valor, aquela fábrica nunca gera alerta.
- **Um saldo negativo não é, por si só, motivo de alerta.** O consumo automático debita a
  fábrica e pode deixá-la negativa — os elementos foram mesmo produzidos. Só há aviso onde
  tiveres definido um mínimo.
- **Quem recebe é a direção** (administrador, diretor de projeto, diretor de obra com e-mail
  na conta), num só e-mail com todas as fábricas agrupadas. A fábrica não recebe: é uma
  empresa externa e não deve ver os saldos de outra.

## 1.9.2 — 2026-08-01

**No iPhone, abrir o endereço sem a barra final oferecia-se para guardar um ficheiro em
vez de abrir a aplicação.** Quem escrevesse `<servidor>/twinflow` (sem `/` no fim)
recebia a pergunta "queres guardar twinflow?" e nunca via a aplicação. No computador
funcionava, o que tornava o problema difícil de acreditar.

O endereço sem barra final responde com um reencaminhamento para a versão com barra. Esse
reencaminhamento saía **sem indicação de tipo de conteúdo**, e o servidor web preenche
essa falta com o seu valor por omissão: `application/octet-stream`, ou seja, "ficheiro
binário". O Chrome ignora o tipo num reencaminhamento e segue em frente; o Safari do iOS
lê "ficheiro" e propõe transferi-lo, com o nome do último pedaço do endereço — `twinflow`.

O reencaminhamento passa a declarar que é HTML. Nada mais muda: o destino é o mesmo, e
quem já usava o endereço com barra final nunca notou diferença nenhuma.

## 1.9.1 — 2026-08-01

**O resto da auditoria visual.** Correções de acabamento e de legibilidade; nada muda na
forma de trabalhar.

- **As cores de estado deixam de ser ilegíveis quando são texto.** O nome do estado era
  escrito na cor do próprio estado, a 11px maiúsculas, sobre um fundo dessa mesma cor a
  12% — o pior fundo possível. Oito dos nove estavam abaixo do mínimo AA. Passa a haver
  uma tinta por estado, usada na etiqueta, no cabeçalho da coluna e no chip do takt; o
  ponto, o preenchimento e o elemento 3D mantêm a cor original.
- **Os chips de movimento de stock** têm texto branco sobre cor sólida, por isso cada cor
  tem de o aguentar: medidos, **cinco dos oito falhavam**. Escurecidos o suficiente para
  passarem, mantendo o tom.
- **A linha selecionada no mapa de quantidades vê-se.** Antes, a única indicação de que
  uma tipologia ia entrar no pedido era um visto de 16px dentro de uma linha de 37px. O
  campo da quantidade ganhou folga a sério, em vez dos 1.4px que tinha.
- **O ✕ que apaga uma zona de takt** tinha uma área de toque de ~7px, para uma ação
  destrutiva, num ecrã que se usa com o polegar.
- Peso tipográfico com uma regra só (600), sem o negrito do browser a entrar por 23
  sítios que o CSS nunca declarou; sete títulos de secção escritos à mão passaram a usar
  a classe que já existia; 73 espaçamentos alinhados à grelha; números tabulares onde os
  dígitos se empilham; marcas dos estados vazios a cinzento em vez de emojis a meio gás.

## 1.9.0 — 2026-08-01

**A interface passa a ter um sistema, não quarenta ecrãs.** Comparei o acabamento com o
das aplicações BIM comerciais (Revit, Archicad, Navisworks, Solibri). A diferença não é
serem mais bonitas — é serem consistentes. A aplicação tinha dezasseis tamanhos de letra
na folha de estilos e mais sete escritos à mão, dez raios de canto, cinco sombras avulsas
e espaçamentos entre 9, 10 e 14px. Cada ecrã era razoável sozinho; juntos liam-se como
montados em vez de desenhados.

Passa a haver uma camada de tokens que todos os componentes consomem: escala tipográfica
de nove degraus, grelha de 4px, quatro raios, três níveis de elevação e uma rampa neutra
fria. **Nada mudou de nome** — 156 seletores antes, 156 depois — porque o JavaScript
procura-os pelo nome.

Ao medir contra o sistema, apareceram defeitos que não eram inconsistências, eram falhas:

- **O texto secundário estava a 2.98:1 sobre branco**, abaixo do mínimo AA de 4.5:1, e
  carregava texto a sério em cerca de trinta sítios. Está em 5.43:1.
- **Não existia uma única regra `:disabled`, `:focus-visible` ou `:active`.** Um controlo
  desativado era visualmente idêntico a um ativo, e quem navega por teclado não via onde
  estava.
- **O cabeçalho fixo das tabelas ficava 20px abaixo do sítio** — um `sticky` mede contra a
  caixa de *padding* do contentor — e as linhas eram pintadas por cima dele.
- **As colunas do mapa de quantidades tremiam a cada passo de scroll**, porque sem
  `table-layout: fixed` o browser remede-as contra as linhas que a virtualização tiver
  montadas naquele instante.
- **Todos os campos estavam abaixo de 16px**, o que faz o Safari do iPhone dar zoom à
  página a cada foco. As checkboxes usavam o azul do sistema, não o da aplicação.
- **A ação principal da vista Modelo só se alcançava com rato**: é um `<label>`, e um
  `<label>` não entra na ordem de tabulação.
- **As notificações nunca eram anunciadas** a um leitor de ecrã.

Duas decisões que vale a pena saber: a paleta tem agora **dois níveis** — as cores de
estado ficam intocadas, porque o three.js pinta o modelo 3D com esses mesmos valores hex,
e há um nível separado, mais escuro, para quando a cor é *texto*. E os **ícones continuam
emojis**: 66 vivem dentro de cada dicionário de tradução, por isso trocá-los é alteração
de conteúdo, não de estilo.

## 1.8.2 — 2026-07-31

**O ecrã de entrada espera pelo servidor que acabou de acordar.** O servidor começa a
atender ANTES de a base de dados estar carregada — de propósito, porque o Passenger mata
uma aplicação que demore a responder. Nessa janela a API responde `starting`, e era essa
palavra, em inglês e numa caixa vermelha, que aparecia a quem tentasse entrar. Carregar
outra vez resolvia — e ensinava que a aplicação é pouco de fiar.

Acontece mais em produção do que localmente: o Passenger adormece a aplicação quando
ninguém a usa, por isso é **a primeira pessoa a entrar depois de uma pausa** que a acorda
e apanha a janela.

- A página passa a repetir o pedido sozinha (até ~9 s), mostrando *"A arrancar o servidor,
  um momento…"* numa caixa neutra — cinzenta, não vermelha: estar à espera não é uma falha.
  O botão fica desativado enquanto espera, e a entrada conclui-se sozinha.
- Só o `starting` é repetido. **Uma palavra-passe errada continua a ser uma tentativa
  única** — repeti-la gastaria o limite de tentativas contra o próprio utilizador.
- Se ao fim das tentativas ainda não estiver pronto, a mensagem é explícita em vez de um
  código: *"O servidor está a demorar mais do que o costume — tenta daqui a pouco"*.

## 1.8.1 — 2026-07-31

**Auditoria de segurança.** Nada muda na forma de trabalhar: são todas correções de
fundo, feitas enquanto a 1.8.0 está em teste com utilizadores.

Cinco áreas apertadas nesta ronda, todas do mesmo feitio — verificações que existiam num
caminho e faltavam noutro: o acesso aos modelos IFC, o limite de tentativas de entrada,
a validação de um campo de apresentação, a identidade dos pedidos (que passa a ser sempre
a que o servidor guardou, e um pedido nasce sempre em rascunho), e o que uma conta de
fábrica — uma empresa externa — pode ver do resto. O detalhe fica no registo interno de
auditoria, fora deste repositório.

## 1.8.0 — 2026-07-29

**Eventos de configuração no registo de decisões.** A 1.7.0 registava as decisões
operacionais; faltava o terreno em que elas são tomadas.

Passam a ser registados: projetos (criar, editar, apagar), **alterações de receitas** com
evento próprio, fornecedores, componentes, contas de utilizador, carregamento de modelos
IFC, e importação ou reposição de dados.

- As **receitas** levam evento separado em vez de ficarem escondidas dentro de
  "projeto alterado": uma receita editada move silenciosamente todo o cálculo de stock
  futuro, e sem isso um modelo veria os saldos mudar sem causa aparente.
- As **contas** explicam quem podia ter decidido. Registam quem, que perfil e quantos
  projetos — e se o perfil ou os projetos mudaram. **Nunca** palavras-passe, nem os seus
  resumos criptográficos, nem fichas de sessão; verificado por pesquisa no ficheiro.
- **Importar** e **repor** dados marcam a costura: um modelo tem de conseguir distinguir
  "o mundo mudou por baixo" de "alguém decidiu". O registo de treino sobrevive de
  propósito a uma reposição — as decisões foram tomadas na mesma.

Ao contrário dos eventos operacionais, estes levam contexto mínimo (só a hora): são atos
raros, e a carteira de pedidos não é aquilo sobre que atuam.

## 1.7.0 — 2026-07-29

**Registo de decisões para treino de IA.** A vista Atividade passa a ser exclusiva do
administrador e ganha, por baixo, uma segunda camada de registo pensada para máquinas.

- **Vista Atividade só para administrador.** Escondida na navegação e recusada mesmo
  que se chegue lá por preferência guardada. O histórico dentro de cada pedido mantém-se
  visível a quem tem acesso a esse pedido — só desaparece a vista transversal.

- **Cada ação passa a gerar um evento estruturado**, com chave estável em vez de texto
  (`order.status.changed`, `stock.move`, `procurement.awarded`, `order.nc.raised`, …),
  o antes e o depois, e quem agiu. Só ações: nada de navegação ou de filtros
  consultados.

- **Com o contexto que existia no momento da decisão** — elementos fabricados, dias até
  à data JIT, cargas em trânsito na obra, stock por componente da receita com falta
  calculada, carteira por estado, pedidos em atraso, hora e dia da semana. Sem isto o
  registo diz o que aconteceu, que não ensina nada; com isto diz *o que se sabia ao
  decidir*.

- **E com o resultado que se veio a verificar**, ligado ao pedido: entregue dentro ou
  fora da data, dias de desvio, tempo total, não conformidades levantadas, cargas
  usadas. É esta parte que transforma histórico em algo aprendível.

  A meteorologia é deliberadamente **não** guardada: deriva-se depois a partir das
  coordenadas do projeto e da data, ambas registadas, e ir buscá-la a cada gravação
  poria uma chamada externa entre o utilizador e o clique dele.

- **Fica fora da base de dados operacional**, num ficheiro JSONL que só cresce por
  acréscimo, rodado por mês, na pasta de dados (já fora do `public_html`). Configurável
  com `TWINFLOW_TRAINING_DIR`. A escrita é assíncrona e falha em silêncio — um problema
  no registo nunca pode impedir alguém de trabalhar.

- **Exportação** para o administrador, na própria vista Atividade, servida em streaming.

Medido com 100 projetos e 5000 pedidos antes de entregar: **12 ms por decisão com
evento e contexto, contra 16 ms sem** — a diferença está abaixo do ruído, o custo não é
mensurável. Cada evento ocupa cerca de 960 bytes, o que dá aproximadamente 84 MB em
cinco anos a 50 decisões por dia.

## 1.6.1 — 2026-07-29

- **Correção: num browser novo, a aplicação mostrava o esqueleto vazio durante 1 a 2
  segundos antes de saltar para a página de entrada.** O cookie de sessão é `HttpOnly`
  — e assim deve ficar — por isso o cliente não sabe se tem sessão sem perguntar ao
  servidor, e era essa pergunta que se via a decorrer.

  Passa a existir uma pista local que diz apenas "este browser já entrou aqui". Sem
  ela, o `index.html` salta para a página de entrada **antes de desenhar seja o que
  for** — confirmado: o `app.js` nem chega a ser descarregado, e o salto dá-se em
  **132 ms** em vez de 1 a 2 segundos.

  A pista não é uma permissão: forjá-la só dá um esqueleto vazio, porque todos os
  pedidos continuam a levar 401 do servidor. É escrita ao entrar e apagada ao sair ou
  quando a sessão caduca.

  A v1.5.0 tinha agravado isto sem o causar: com muito menos JavaScript para analisar,
  a página passou a pintar mais cedo e o intervalo vazio ficou mais visível.

- Os dois tipos de letra passam a ser pedidos no cabeçalho, em vez de só serem
  descobertos depois de o CSS ser analisado. Já eram `woff2` com cache imutável — muda
  quando começam, não o tamanho.
- **Correção:** o servidor Node não conhecia `.woff2` e servia-o como
  `application/octet-stream`, o que faz o browser descartar o pedido antecipado e ir
  buscar o ficheiro outra vez. Em produção o nginx já o servia corretamente.

## 1.6.0 — 2026-07-29

- **O administrador passa a ter poderes totais.** Quatro regras do processo aplicavam-se
  a todos os perfis sem exceção e agora o administrador — e só ele, nem sequer o diretor
  de projeto — pode ultrapassá-las: começar produção sem desenhos de fabrico validados,
  expedir sem data e hora JIT vinculativas, enviar uma segunda carga com outra em
  trânsito, e eliminar um pedido já iniciado.

  As três primeiras escrevem **🔓 Administrator override** no histórico do pedido, com o
  motivo, visível no detalhe e no Registo de Atividade. A eliminação só pode ficar no log
  do servidor, porque o pedido deixa de existir.

  Estas regras não são permissões, são factos físicos — uma peça não se fabrica sem
  desenhos aprovados, uma obra não descarrega dois camiões que não consegue receber. Dar
  poder de as ultrapassar é legítimo; deixá-lo passar em silêncio faria o histórico
  mentir.

- **O diretor de projeto passa a ter âmbito por projeto.** Antes via todos os projetos
  por definição e qualquer atribuição era ignorada. Agora o administrador escolhe que
  projetos cada diretor cobre — pensado para a rotação de pessoas: quando um diretor sai
  e entra outro, adiciona-se o novo ao projeto.

  Os poderes mantêm-se todos (validar desenhos, mover o fluxo, criar pedidos), mas dentro
  dos projetos atribuídos. *Poderes totais* e *ver tudo* eram a mesma coisa no código e
  deixaram de ser. O administrador continua sem âmbito.

  Os diretores existentes herdam todos os projetos que existirem no momento da
  atualização — **uma única vez**, com marcador guardado na base de dados. Sem isto, a
  regra de âmbito (lista vazia = nenhum projeto) deixaria todos com o ecrã em branco no
  primeiro arranque.

- **Correção:** um diretor de projeto que criasse um projeto deixava de o ver de imediato,
  por o projeto novo não entrar no âmbito de ninguém. Quem cria fica automaticamente com
  acesso.
- **Correção:** eliminar um projeto não verificava o âmbito — não havia âmbito a verificar
  até agora.

## 1.5.0 — 2026-07-27

Auditoria de desempenho de carregamento. Antes: **6,84 MB descomprimidos e 688 KB de
rede** em cada abertura da aplicação. Depois: **329 KB e 75 KB** para quem não abre a
vista 3D — menos **95%** do que o browser tem de analisar.

- **O motor 3D e o leitor de IFC passam a carregar a pedido.** Eram importados
  estaticamente, por isso quem abrisse o Registo de Atividade no telemóvel descarregava
  e compilava 6,4 MB de JavaScript para ver uma tabela. Passam a ser carregados na
  primeira entrada na vista Modelo, que é o único sítio onde fazem falta.
- **Os módulos próprios são pedidos em paralelo** (`modulepreload`). O browser só
  descobria o `store.js` e o `i18n.js` depois de analisar o `app.js` — uma cascata que
  custava dois tempos de ida-e-volta num telemóvel.
- **Cada conta carrega só o seu idioma.** Os dicionários iam os dois em todos os
  carregamentos, 81 KB dos quais metade nunca era usada. Divididos em `js/lang/`, com
  aviso na consola se alguma chave faltar.
- **O servidor Node passa a comprimir** texto com Brotli ou gzip. Não muda nada em
  produção, onde o nginx já o faz; é para quem corra a aplicação diretamente sobre Node.
- **Correção:** as etiquetas QR carregavam a biblioteca a partir da raiz do domínio,
  perdendo o prefixo `/twinflow` — em produção **todas as etiquetas saíam sem código QR**.
- A versão passa a mostrar um **identificador de build** (`build a3f9c1`) em vez da data
  e hora. É um resumo do tamanho e data dos ficheiros da aplicação: dois servidores com
  o mesmo identificador estão comprovadamente a correr os mesmos ficheiros, coisa que
  uma data não garantia.

Não foram alterados dois pontos que a auditoria também examinou, por não serem problema:
a produção já serve tudo em **Brotli**, e das 133 classes de CSS só **uma** não era
usada — 86 bytes em 29 KB.

## 1.4.0 — 2026-07-26

- **Registo de Atividade (📜)** — vista nova. Até aqui cada ato estava registado,
  mas só era visível dentro do registo a que pertencia: responder a "o que se passou
  esta semana, e quem fez o quê" obrigava a abrir pedido a pedido.

  Junta num só sítio, do mais recente para o mais antigo, os passos dos pedidos de
  produção, os movimentos de stock e as fases das encomendas. **Não regista nada de
  novo** — lê os históricos que já existiam. Filtra por projeto, tipo, autor e texto.

  Os perfis limitados a projetos continuam a ver apenas o que lhes compete: o
  servidor já lhes entrega um estado filtrado, por isso a vista só pode agregar
  aquilo a que teriam acesso de qualquer forma.

  Testado com 100 projetos, 5000 pedidos e 20 000 movimentos antes de ser instalado.
  O teste apanhou o que era de esperar: juntar os três rastos dá 56 000 registos e
  refazer isso a cada tecla tornava a pesquisa inutilizável. A lista passa a ser
  construída uma vez por visita e só a filtragem corre a cada tecla — e a caixa de
  pesquisa deixou de ser destruída e recriada, portanto já não perde o cursor.

  Nota: os atos dos pedidos foram gravados com o texto em inglês desde o início, por
  isso aparecem em inglês mesmo com a aplicação em português. Corrigi-lo obriga a
  mudar a forma como são gravados; fica identificado.

## 1.3.0 — 2026-07-26

- **As credenciais de SMTP podem passar a viver fora da pasta pública**, com a
  variável `TWINFLOW_SMTP_CONFIG`. Fecha a categoria aberta na 1.2.0: o
  `smtp-config.json` tem a palavra-passe da conta de e-mail e estava protegido
  apenas por uma regra no `.htaccess`.

  Ao contrário da base de dados, este ficheiro **não** é copiado automaticamente
  para o novo local — copiar um segredo e deixar o original para trás é o
  comportamento errado por omissão. Move-se de propósito, à mão.

  Se a variável apontar para um ficheiro que não existe, o envio de e-mail deixa
  de funcionar em silêncio. Para isso não passar despercebido, o arranque diz
  sempre de onde leu a configuração e avisa se o ficheiro antigo ainda lá estiver.

## 1.2.0 — 2026-07-26

- **A base de dados e os modelos IFC podem passar a viver fora da pasta pública.**
  Duas variáveis de ambiente novas, `TWINFLOW_DATA_DIR` e `TWINFLOW_MODELS_DIR`.
  Sem elas, tudo se mantém exatamente como estava.

  Porquê: neste alojamento os ficheiros estáticos são servidos fora do Node, por isso
  a única coisa que impedia a base de dados de ser descarregada era uma regra no
  `.htaccess` — e essa base de dados tem palavras-passe e **fichas de sessão ativas**.
  Fora da pasta pública deixa de existir caminho até ela, com ou sem `.htaccess`.

  **Salvaguarda:** apontar as variáveis para pastas vazias arrancaria com a base de
  dados em branco, o que pareceria perda total de dados. Por isso o primeiro arranque
  no novo local **copia** o que já existe — base de dados e modelos. Copia, nunca move:
  os originais ficam onde estão até serem apagados à mão, depois de o novo local estar
  comprovado.
- O arranque passa a dizer no registo onde estão os dados e se é dentro ou fora da
  pasta pública.

## 1.1.0 — 2026-07-26

- **Escritas recusadas pelo servidor deixam de ser silenciosas.** Uma alteração
  recusada (valor inválido, perfil sem permissão) ficava no ecrã como se tivesse sido
  gravada. O caso visível era apagar um pedido já aceite pela fábrica: o cartão
  desaparecia e voltava sozinho na sincronização seguinte. Agora a alteração é
  revertida e o motivo é mostrado. Trabalhar sem rede continua a funcionar — falta de
  ligação não é tratada como recusa.
- **Versão em execução no rodapé**, com a data da última atualização dos ficheiros no
  servidor. Repetida em ⚙ Configuração, porque no telemóvel o rodapé lateral não é
  visível.

## 1.0.0 — 2026-07-26

Primeira versão numerada, já em produção.

- **Contactos dos fornecedores separados em e-mail e telefone.** Eram um só campo de
  texto livre, o que obrigava a extrair o endereço com uma expressão regular antes de
  cada envio. O e-mail passa a ser validado no cliente e no servidor — fecha também a
  injeção de destinatários no envio de correio.
- **Contactos clicáveis**: o telefone abre o marcador, o e-mail abre a aplicação de
  correio. Na lista de fornecedores, no detalhe do pedido e nas encomendas.
- Em ecrã de telemóvel a lista de fornecedores passa a empilhar — a coluna do telefone
  estava a ser cortada, precisamente onde é precisa.
- Correção: o botão "Enviar e-mail à fábrica" não funcionava em rascunhos. Faltava uma
  verificação num botão que não existe nesse estado, e o erro deixava por ligar tudo o
  que vinha a seguir.
- "Parceiros" passa a "Fornecedores" em toda a interface.

## 0.9.2 — 2026-07-26

- Correção: ao submeter um pedido, ia para destinatário o campo de contacto inteiro
  (`e-mail · telefone`) em vez do endereço. Passou a extrair só o endereço.

## 0.9.1 — 2026-07-26

- Correção: a **janela de meteorologia da grua estava morta em silêncio** desde a
  auditoria de segurança — a política de conteúdos não autorizava os dois domínios do
  Open-Meteo, e o código engolia a falha e mostrava previsão vazia.
- Conjunto de dados de demonstração arrumado antes de ser distribuído.

## 0.9.0 — 2026-07-26

- **Versionamento por pedido.** Edições em simultâneo apagavam-se umas às outras: a
  guarda anterior comparava o número de eventos, por isso duas pessoas a acrescentar
  uma entrada cada pareciam ambas atuais e a segunda escrevia por cima da primeira —
  uma inspeção da qualidade a apagar uma não conformidade de um diretor, ambas dadas
  como gravadas. Agora o cliente devolve a versão que leu e uma divergência é recusada,
  com aviso de que a ação **não** foi gravada.

## 0.8.0 — 2026-07-25

Conjunto de alterações a partir da tabela de controlo do engenheiro de obra.

- **Vista de Montagem (👷)** com espaço próprio: fases por elemento (colocado → fixado
  → diafragmas → preparação de grout → grouteado), registáveis **em série** sobre vários
  elementos ao mesmo tempo e filtráveis por piso, zona takt, classe, pedido e fase em
  falta. Ícone próprio na navegação, e deixou de aparecer no detalhe do pedido — ali
  duplicava informação sobre a qual não se podia agir.
- **Desenhos de fabrico**: a fábrica submete, o diretor de projeto valida, e só depois
  pode começar a produção.
- **Ciclo das não conformidades**: aberta → reparada → validada, com a validação
  reservada à direção de obra. A fábrica pode levantar uma NC, mas não a valida.
- **Encomendas a fornecedores**: adjudicado → faturado → entregue, e marcar a entrega
  regista a entrada em armazém no mesmo ato.
- **Um camião de cada vez**: não sai carga nova enquanto a anterior estiver em trânsito.

## 0.7.0 — 2026-07-25

- Vista de Stock separada em **Saldos** e **Movimentos**, com os movimentos agrupados
  por pedido e componente — uma linha de resumo que expande para mostrar as linhas que
  a compõem, com as respetivas notas.

## 0.6.0 — 2026-07-25

- **Painel remodelado**, com vários tipos de gráfico.
- **Data JIT**: na criação passa a ser uma data **aproximada**; a data e hora
  vinculativas são exigidas mais tarde, no passo de pronto → em trânsito.
- **Quem pede o envio para obra são os diretores de projeto e de obra**, não a fábrica —
  são eles que sabem o andamento da obra. A fábrica termina em "Pronto".
- Permissões alinhadas entre cliente e servidor, com todas as regras aplicadas também
  no servidor.
- As janelas deixam de fechar ao clicar fora: um clique ao lado fazia perder o que
  estava preenchido. Fecham só em Cancelar ou Aprovar.

## 0.5.0 — 2026-07-17

Ponto de partida do registo: aplicação com leitura de IFC, mapa de quantidades, pedidos
de produção, stock de componentes, contas de utilizador com oito perfis e persistência
em base de dados no servidor.

---

## Fora da aplicação

Alterações em produção que não estão no código e por isso não têm número:

- **2026-07-25** — reforço do `.htaccess`: os ficheiros do servidor e as pastas de dados
  passaram a estar explicitamente vedados ao exterior. O detalhe fica no registo interno.
- **2026-07-26** — afinados os cabeçalhos das páginas e o **controlo de cache** no
  `.htaccess` — sem ele os deploys não chegavam aos browsers, e foi isso que fez perder
  dados durante uma importação.

A causa é sempre a mesma e convém não a esquecer: em produção os ficheiros estáticos são
servidos fora do Node, por isso as regras escritas em `serve.mjs` só valem para `/api/*`.
