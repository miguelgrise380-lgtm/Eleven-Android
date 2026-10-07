# Eleven (web — PC e celular) com Groq

Deepgram (escuta "Eleven") → **Groq (gpt-oss-120b)** → ElevenLabs (fala).

Nada é baixado no aparelho: o cérebro roda na Groq, via função do Netlify (a chave fica no servidor).

## Deploy no Netlify
1. Suba esta pasta para um repositório (o `netlify.toml` já define build `npm run build` e publish `dist`).
2. Em **Site configuration > Environment variables**: `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` e `GROQ_API_KEY`
   (opcionais: `GROQ_MODEL`, `YOUTUBE_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`).
3. Abra o site em HTTPS e toque em **Ativar Eleven**.

A chave do Deepgram precisa de permissão Member ou superior (gera tokens temporários).

## Requisitos
- Qualquer navegador moderno com microfone (Chrome, Edge, Safari). Não precisa de WebGPU.
- Internet durante o uso.

## O que ela faz por você (ferramentas)
A Eleven não só conversa: ela executa. A Groq escolhe a ferramenta certa:
- **Lembretes e timers**: "me lembra em 20 minutos de tirar a comida", "me avisa às 15h" (avisa por voz e notificação; ficam salvos no aparelho).
- **Notas e tarefas**: "anota comprar pão", "o que tenho pra fazer?", "tira pão da lista".
- **E-mail**: "escreve um e-mail pro João cancelando a reunião" abre o rascunho pronto no Gmail.
- **WhatsApp**: abre a conversa com a mensagem já escrita.
- **Agenda**: "marca dentista amanhã às 14h" abre o evento pronto no Google Agenda.
- **Tempo, fatos e contas**: previsão (Open-Meteo), Wikipédia e calculadora.
- **Textos prontos**: "escreve uma carta de apresentação" mostra no painel com botão Copiar.
- **Sites, links e YouTube**: como descrito abaixo.
**Confirmação antes de abrir:** para e-mail, WhatsApp, agenda e sites, a Eleven pergunta "Posso abrir o e-mail?" e só abre quando você diz sim (pode, claro, abre...). Dizendo não, ela cancela. O YouTube abre direto, sem perguntar.
Por segurança, e-mail, WhatsApp e agenda abrem prontos para você revisar e tocar em enviar/salvar.

## Fotos e metadados
- Diga "Eleven, deixa eu escolher uma foto": ela responde "Tá bom." e abre a seleção de arquivos. Se o navegador bloquear (voz não conta como toque), toque no botão **Escolher foto** que aparece na tela.
- Ao escolher, ela diz "Recebi sua foto, o que você quer que eu faça com ela?" e mostra a foto no painel.
- Depois peça o que quiser. Exemplos:
  - **Metadados:** "de onde foi tirada?", "qual a latitude e longitude?", "que câmera?", "mostra todos os metadados". "Copia a latitude e longitude" copia na hora.
  - **Entender a imagem:** "o que é isso?", "identifica tudo que tem na foto", "lê o texto da imagem", "quantas pessoas/carros tem?", "qual a cor predominante?", "tem algum QR code?". Ela nunca identifica pessoas pelo nome.
  - **Localizar:** "marca os carros na foto" (caixas aproximadas).
  - **Editar:** "gira 90 graus", "espelha", "corta quadrado", "deixa preto e branco", "aumenta o brilho", "desfoca", "esconde os rostos", "escreve 'Férias 2026' embaixo", "diminui para 1000 pixels". "Desfaz" volta um passo e "volta ao original" desfaz tudo.
  - **Guardar e enviar:** "salva a foto", "copia a imagem", "compartilha", "imprime", em PNG, JPEG ou WebP. Imagens exportadas saem sem metadados (EXIF/GPS).
  - **Mais:** "estou longe de onde foi tirada?" (usa a sua localização) e "tira uma foto" (abre a câmera).
- **Pede permissão antes do que é mais forte:** salvar, copiar, compartilhar, imprimir e usar sua localização. Ela pergunta "Posso ...?" e só faz se você disser sim. Compartilhar e imprimir ainda exigem um toque no botão que aparece, regra do navegador.
- **O que o navegador não faz sozinho:** remover fundo e melhorar resolução com IA precisam de bibliotecas extras e não estão incluídos.
- **Ela vê a foto assim que chega:** a imagem é enviada à Groq (modelo de visão) para uma análise completa (texto, objetos, tabuleiros de xadrez, tabelas etc.), e essa análise fica disponível em toda a conversa. Para problemas difíceis (xadrez, matemática), ela pede um raciocínio mais profundo sobre a imagem, que pode demorar. Se der erro de tempo esgotado, aumente o timeout das funções no Netlify (Project configuration > Functions).
- Os metadados são lidos no seu aparelho (biblioteca exifr). Só para "veja o que é" a foto, reduzida, é enviada à Groq (modelo de visão, variável opcional `GROQ_VISION_MODEL`, padrão `qwen/qwen3.8-27b`). O nome do local vem do OpenStreetMap.
- Sem GPS? WhatsApp e redes sociais removem a localização, e no Android é preciso permitir o acesso à localização da mídia ao escolher o arquivo. Fotos HEIC podem não abrir no Chrome.

## Resposta imediata e biometria
- **Sem demora:** ao ouvir só "Eleven", ela responde na hora com uma frase curta já carregada ("Sim?", "Pois não?"), sem esperar a Groq.
- **Biometria na primeira vez:** ao ativar e chamar "Eleven" pela primeira vez, ela pede a biometria do aparelho (digital, rosto ou PIN) antes de responder. Na primeira vez no aparelho ele cadastra a credencial; depois só confirma. Vale até desativar a Eleven ou fechar a aba. Se o navegador exigir um toque, aparece o botão "Verificar biometria".
- Para desligar a trava, mude `REQUIRE_BIOMETRIC` para `false` em `src/biometric.ts`.

## TV Samsung (opcional)
Controle por voz via SmartThings ("liga a TV", "aumenta o volume"...). Também abre apps da TV ("abre o YouTube na TV", "modo TV"). Configuração, limites e remoção em `docs/TV_SMARTTHINGS.md`.

## Conversa natural
- **Pode interromper:** se você falar enquanto ela está falando, ela para na hora e escuta. Depois, se você disser "continua" (ou "ok", "entendi"), ela retoma de onde parou; se disser outra coisa, ela responde ao que você falou.
- **Vídeo do YouTube:** ao chamar "Eleven" com um vídeo tocando, o vídeo pausa na hora para ela te ouvir sem o som atrapalhar, e volta sozinho quando ela termina. Diga "pausa o vídeo" para deixá-lo parado e "continua o vídeo" para retomar.
- Use fones de ouvido se puder: sem eco, a interrupção funciona melhor.

## Como usar
- Diga **"Eleven"** para começar; a conversa continua sem repetir o nome.
- Encerrar: "até mais", "tchau", "pode parar"... (ou 5 min de silêncio).
- Comandos (entendidos na hora, por regras): "abre o YouTube", "toca [música]", "pesquisa [assunto]",
  "mostra imagens de [coisa]", "mostra [lugar] no mapa", "como chego em [lugar]", "fecha o painel".
- **Qualquer site ou link**: diga "abre [nome do site]" (a Groq descobre o endereço) ou cole/fale um link ("abre youtube.com/watch?v=...", "abre facebook.com/..."). Links de vídeo do YouTube tocam dentro do painel.
- O YouTube toca dentro do painel (precisa de `YOUTUBE_API_KEY`). A pesquisa mostra um resumo da Wikipédia e um botão
  para ver o Google. Mapas aparecem no painel. Os demais sites (Spotify, Netflix, Gmail...) não podem aparecer dentro
  de outra página: o painel mostra um botão que abre em nova aba.
- Todo o resto vai para a conversa com a Groq.
- Com vídeo tocando, ela só reage quando ouve "Eleven".

## Limites
- Para trocar o modelo, defina `GROQ_MODEL` no Netlify (ex.: `qwen/qwen3.6-27b`. Os modelos Llama 3.x foram desligados pela Groq em 16/08/2026; confira a lista atual em console.groq.com/docs/models).
- O plano grátis da Groq tem limite de requisições por minuto/dia.
- Navegadores bloqueiam abrir abas sem um toque seu: a Eleven tenta abrir em nova aba e, se bloquear, o painel mostra um botão. No celular, abrir outra aba pausa a Eleven (a aba precisa ficar em primeiro plano).
- O app mantém a tela ligada, mas a aba precisa ficar em primeiro plano no celular.


## App Android (Capacitor)
Veja [docs/CAPACITOR_ANDROID.md](docs/CAPACITOR_ANDROID.md): microfone, arquivos, câmera, localização e notificações já configurados.
