# TwinFlow — modelo de dados

Diagrama entidade-relação da plataforma, tirado do código e dos dados reais (v1.16.0).

**Uma nota antes de o ler.** Isto não é uma base de dados relacional clássica. O SQLite
guarda sete tabelas em que quase tudo vive numa coluna `data` em JSON, e as entidades a
cinzento no diagrama **não têm tabela própria**: são listas dentro do JSON do pedido, ou
objetos indexados por chave. Foram desenhadas na mesma porque são entidades do domínio — o
diagrama descreve o negócio, e a seguir explica-se onde é que cada uma mora de facto.

```mermaid
erDiagram
    USER ||--o{ SESSION : "abre"
    USER }o--o{ PROJECT : "tem acesso a (projectIds)"
    USER }o--|| PARTY : "pertence à fábrica (partyId)"

    PROJECT ||--o{ ELEMENT_GROUP : "agrupa"
    PROJECT ||--o{ ORDER : "origina"
    PROJECT ||--o{ RECIPE_LINE : "define receita"
    ELEMENT_GROUP ||--o{ ELEMENT : "contém"

    ORDER }o--|| PARTY : "adjudicado a"
    ORDER ||--o{ ORDER_ITEM : "pede"
    ORDER ||--o{ ORDER_EVENT : "regista"
    ORDER ||--o{ NON_CONFORMITY : "levanta"
    ORDER ||--o{ INSPECTION : "passa por"
    ORDER ||--o| SHOP_DRAWING : "aguarda"
    ORDER ||--o{ ASSEMBLY_TRACK : "acompanha em obra"
    ORDER_ITEM }o--|| ELEMENT_GROUP : "de"

    COMPONENT ||--o{ STOCK_MOVE : "movimenta"
    COMPONENT ||--o{ RECIPE_LINE : "entra em"
    COMPONENT ||--o{ PROCUREMENT : "é encomendado em"
    COMPONENT ||--o{ FACTORY_BALANCE : "tem saldo em"
    FACTORY_BALANCE }o--|| PARTY : "na fábrica"

    STOCK_MOVE }o--o| PARTY : "na fábrica"
    STOCK_MOVE }o--o| ORDER : "consumido por"
    PROCUREMENT }o--|| PARTY : "ao fornecedor"

    USER {
        string id PK
        string username UK
        string name
        string role "admin, project_director, site_director, foreman, quality, factory, logistics, site"
        string_array projectIds FK "projetos a que acede"
        string partyId FK "fábrica a que pertence (1.16.0)"
        string email
        string lang
        string salt "scrypt"
        string hash "scrypt"
        bool mustChangePassword
        string createdAt
    }
    SESSION {
        string token PK
        string userId FK
        string createdAt "expira aos 30 dias"
    }
    PROJECT {
        string id PK
        string name
        string address
        float lat
        float lon
        string fileName "IFC de origem"
        string importedAt
        json summary "totais do QTO"
    }
    ELEMENT_GROUP {
        string key PK "tipo|nome"
        string type "classe IFC"
        string name
        int count
        float volume
        float area
        float length
        float weight
        string_array storeys
    }
    ELEMENT {
        string globalId PK "GUID do IFC"
        string groupKey FK
        string storey
    }
    ORDER {
        string id PK
        string code UK "PR-0001"
        string projectId FK
        string supplierId FK "fábrica que produz"
        string status "draft, submitted, accepted, rejected, production, ready, transit, delivered, installed"
        string needBy "estimativa na criação"
        string jitAt "data e hora vinculativa antes do despacho"
        string zoneId "zona de takt"
        int orderRev "versão, para o guarda de concorrência"
        string createdAt
    }
    ORDER_ITEM {
        string key FK "grupo de elementos"
        string name
        string unit
        float qty
        float volume
        float area
        float weight
        string_array globalIds "os elementos concretos"
    }
    ORDER_EVENT {
        string ts PK
        string actor
        string action
        string note
    }
    NON_CONFORMITY {
        string id PK
        string ts
        string actor
        string note
        string status "open, repaired, validated"
    }
    INSPECTION {
        string ts PK "as inspeções são uma LISTA, não um mapa por portão"
        string gate "ready (saída) ou delivered (receção)"
        string actor
        bool pass
        json checks
        string note
        string photo "data URI validado no servidor"
    }
    SHOP_DRAWING {
        string status "submitted, validated, waived"
        string ref
        string submittedAt
        string submittedBy
        string validatedAt
        string validatedBy "só o diretor de projeto"
    }
    ASSEMBLY_TRACK {
        string globalId PK
        bool lifted
        bool fixed
        bool diaphragms
        bool groutPrep
        bool grouted
    }
    PARTY {
        string id PK
        string name
        string type "supplier, factory, logistics, site, admin"
        string email
        string phone
    }
    COMPONENT {
        string id PK
        string name "descrição única desde 1.16.0"
        string ref
        string unit "un, kg, m, m2, m3, L"
        string type "família — FIXAÇÃO, CALÇOS…"
        string size "medida"
        string standard "norma"
        string brand "marca"
        string location "palete"
        string importKey "identidade da linha da folha"
        float minQty "mínimo em armazém"
        float warehouseQty "saldo, mandado pelo livro"
        float consumedQty
        string archivedAt "retirado de uso"
        string archivedBy
        string createdAt
    }
    FACTORY_BALANCE {
        string factoryId PK
        float qty "factoryQty[fábrica]"
        float minQty "factoryMinQty[fábrica]"
    }
    STOCK_MOVE {
        string id PK
        string ts
        string componentId FK
        string type "in, send, consume, use, defect, loss, adjust, reverse"
        float qty
        string factoryId FK
        string orderId FK
        string orderCode
        string projectId FK
        string by
        string note
        string reversedBy FK "o estorno que o anulou"
    }
    RECIPE_LINE {
        string groupKey PK "por grupo de elementos"
        string componentId FK
        float qtyPer "por elemento"
    }
    PROCUREMENT {
        string id PK
        string componentId FK
        string supplierId FK
        float qty
        string status "awarded, invoiced, delivered"
        string awardedAt
        string invoicedAt
        string deliveredAt
        string by
        string note
    }
```

## Onde é que cada coisa mora

O SQLite (`data/twinflow.db`) tem **sete tabelas**, e só as cinco primeiras correspondem a
entidades do diagrama:

| Tabela | Entidade | O que está em `data` (JSON) |
| --- | --- | --- |
| `projects` | PROJECT | `groups` (ELEMENT_GROUP → ELEMENT), `recipes` (RECIPE_LINE), `summary` |
| `orders` | ORDER | `items`, `events`, `nonConformities`, `inspections` (lista), `tracking`, `shopDrawings` |
| `parties` | PARTY | contactos |
| `components` | COMPONENT | descritores, `factoryQty` e `factoryMinQty` (FACTORY_BALANCE) |
| `stock_moves` | STOCK_MOVE | o movimento inteiro |
| `procurement` | PROCUREMENT | a encomenda inteira |
| `meta` | — | `rev`, `seq` e os marcadores de migração |

**USER e SESSION vivem à parte**, fora do estado partilhado, porque só o servidor lhes toca
e nunca são enviados para o cliente com as palavras-passe.

## As regras que o diagrama não consegue mostrar

Um ER diz que uma coisa aponta para outra. Não diz **quando** é que apontar é legítimo, e
neste sistema é aí que está quase toda a lógica:

- **ORDER.status não é um campo livre, é uma máquina de estados.** `draft → submitted →
  accepted → production → ready → transit → delivered → installed`, e cada passo tem um
  perfil que o pode dar. Três portões são obrigatórios: desenhos de fabrico validados antes
  de produzir, data e hora JIT antes de despachar, e uma só carga em trânsito de cada vez.
- **O saldo de um componente é uma consequência, não um valor.** `warehouseQty` e
  `factoryQty` só mudam por STOCK_MOVE. Uma importação de inventário cria movimentos de
  entrada a sério, precisamente para que nenhum número no armazém fique sem explicação.
- **RECIPE_LINE é o que liga o modelo ao stock.** Ao produzir, a receita do grupo diz quantos
  componentes cada elemento leva, e o servidor gera os movimentos `consume` sozinho.
- **ORDER_ITEM guarda `globalIds`** — os GUID do IFC. É esse fio que deixa seguir um painel
  do modelo até estar betumado em obra (ASSEMBLY_TRACK).
- **`orderRev` é o guarda de concorrência.** Quem escreve devolve a versão que leu; se não
  bater certo o servidor recusa (409). O administrador ultrapassa os portões de processo,
  mas **não** este — não é uma permissão, é o facto de outra pessoa ter escrito primeiro.
- **USER.partyId decide o que existe.** Uma conta ligada a uma fábrica recebe do servidor
  apenas o saldo dessa fábrica; o saldo de armazém chega como `null`. O que essa conta não
  pode ver não sai do processo.

## Fora da base de dados

- `models/<projectId>.ifc` — o ficheiro IFC de cada projeto, com versões anteriores
  arquivadas ao lado. Fora do webroot em produção.
- `<data>/training/*.jsonl` — o registo de decisões: cada ato com o contexto que existia no
  momento e o resultado que se veio a verificar. Sobrevive de propósito a uma reposição de
  dados.
- `<data>/backups/` — cópia diária da base de dados, as últimas 14.
