# Controle da TV Samsung (SmartThings)

Comandos de voz: "Eleven, liga a TV", "desliga a TV", "aumenta o volume", "diminui o volume", "volume 25",
"muta a TV", "desmuta", "próximo canal", "muda para o HDMI 2".

## Abrir aplicativos na TV
- **Direto:** "Eleven, abre o YouTube **na TV**", "abre o Netflix na TV", "abre o Spotify na TV".
- **Modo TV:** diga "Eleven, modo TV" e aí "abre o YouTube" já abre na TV. Se o app não existir no catálogo da TV (ex.: Facebook), ela abre no navegador como antes. "Modo normal" volta ao padrão (abrir sites aqui). Por padrão o modo é normal, para não mudar o que já funcionava.
- **Catálogo:** YouTube, Netflix, Prime Video, Disney+, Spotify, Apple TV, Globoplay, Telecine, Samsung TV Plus, Tubi, Peacock, SmartThings, Google Meet e Internet (navegador da TV).
- **Outros apps:** dizendo "na TV", ela tenta abrir pelo nome falado (funciona para alguns apps). Para garantir, adicione o ID do app na variável `TV_APPS_JSON` do Netlify, por exemplo `{"max":"ID_DO_APP","pluto tv":"ID_DO_APP"}`. IDs de apps Samsung: lista da comunidade em github.com/xchwarze/samsung-tv-ws-api (APPLICATIONS.md).
- **Limites:** a SmartThings **não informa quais apps estão instalados** na TV, então não dá para abrir "qualquer app" automaticamente sem o nome ou ID. A TV precisa estar **ligada** (se estiver desligada, ela avisa). Esse recurso da SmartThings (`custom.launchapp`) é experimental e pode variar por modelo de TV.

## Como funciona (e por que é seguro)
- O navegador chama só `/.netlify/functions/tv`. O token da SmartThings e o ID da TV ficam **somente no servidor**.
- A função exige a chave `TV_ACCESS_KEY` (cabeçalho `x-tv-key`). Na primeira vez que você der um comando, o app pede essa chave uma vez e guarda no aparelho.
- Só ações de uma lista fechada são aceitas (ligar, desligar, volume, mudo, canal, entrada).
- Importante: tokens pessoais (PAT) da SmartThings **expiram em 24 horas**. Por isso o modo recomendado usa OAuth: a função renova o token sozinha e guarda o novo refresh token (de uso único) no Netlify Blobs.

## Configuração (uma vez)
1. **TV no SmartThings:** adicione a TV no app SmartThings. Para ligar pela rede, ative na TV a opção de ligar por rede/celular (ex.: "Ligar com celular").
2. **ID da TV:** instale o CLI (`npm i -g @smartthings/cli`), rode `smartthings devices` e copie o ID da TV.
3. **App OAuth:** rode `smartthings apps:create`, escolha *OAuth-In App*, escopos `r:devices:*`, `w:devices:*`, `x:devices:*`, e use como redirect URI o endereço do seu site (ex.: `https://SEU-SITE.netlify.app/`). Anote o **Client ID** e o **Client Secret** (só aparecem uma vez).
4. **Autorizar:** abra no navegador
   `https://api.smartthings.com/oauth/authorize?client_id=SEU_CLIENT_ID&response_type=code&redirect_uri=https://SEU-SITE.netlify.app/&scope=r:devices:*+w:devices:*+x:devices:*`
   Entre, aceite, e copie o valor de `code=` da barra de endereço (vale poucos minutos).
5. **Trocar o código por tokens:**
   `curl -X POST https://api.smartthings.com/oauth/token -u CLIENT_ID:CLIENT_SECRET -d grant_type=authorization_code -d code=CODIGO -d client_id=CLIENT_ID -d redirect_uri=https://SEU-SITE.netlify.app/`
   Guarde o `refresh_token` da resposta.
6. **Variáveis no Netlify** (Site configuration > Environment variables):
   `TV_ACCESS_KEY` (invente uma senha longa), `SMARTTHINGS_DEVICE_ID`, `SMARTTHINGS_CLIENT_ID`, `SMARTTHINGS_CLIENT_SECRET`, `SMARTTHINGS_REFRESH_TOKEN`.
7. Faça um novo deploy e diga "Eleven, liga a TV". Digite a `TV_ACCESS_KEY` quando o app pedir.

Se ficar mais de ~29 dias sem usar, o refresh token expira e é preciso repetir os passos 4 a 6.

**Teste rápido (sem OAuth):** em vez dos passos 3 a 5, crie um token em https://account.smartthings.com/tokens (escopos de dispositivos) e use `SMARTTHINGS_TOKEN`. Ele expira em 24 h.

## Como remover a integração
1. Apague `netlify/functions/tv.ts`, `src/tv.ts` e este arquivo.
2. Em `src/main.ts`, apague a linha `import ... "./tv"` e o bloco entre `// [TV-SMARTTHINGS] início` e `// [TV-SMARTTHINGS] fim`.
3. Em `package.json`, remova a dependência `@netlify/blobs` (se nada mais a usar) e, no Netlify, as variáveis `TV_*` e `SMARTTHINGS_*`.
Procure por `TV-SMARTTHINGS` no projeto para conferir que não sobrou nada.
