#!/bin/bash
# Progresso da cadeia do marco em %, calculado do que existe em disco.
# Emite uma linha por minuto SOMENTE quando o percentual muda — silencio
# significa "mesma porcentagem", nunca "parado" (os marcos de etapa provam).
cd '/c/Users/user/Desktop/projetos/_REF_PRODUCAO/ANALISADOR_T4_RTD/ANALISADOR_T4_RTD' || exit 1
D='/c/Users/user/AppData/Local/Temp/claude/C--Users-user-Desktop-projetos--REF-PRODUCAO/802c0c0d-3353-4235-90d1-02a0f0d4faa1/scratchpad'
ULTIMO=-1
while true; do
  PCT=$(node -e '
const fs=require("fs");
const RAIZ="t4-learning";
function conta(dir){try{return fs.readdirSync(dir).filter(f=>/^dia-\d+\.json$/.test(f)).length}catch(e){return 0}}
let totalDias=15;
let fronteirasPct=0;
try{
  const fb=JSON.parse(fs.readFileSync(`${RAIZ}/dataset/marco/day-boundaries-frozen.json`,"utf8"));
  totalDias=fb.dias.length; fronteirasPct=1;
}catch(e){
  try{
    const log=fs.readFileSync(process.env.LOGF,"utf8");
    const m=log.match(/candidatos por gap>=600: (\d+)/);
    const feitos=(log.match(/ → (CONFIRMED|REJECTED|AMBIGUOUS)/g)||[]).length;
    if(m) fronteirasPct=Math.min(1,feitos/Number(m[1]));
  }catch(e2){}
}
const base=conta(`${RAIZ}/reports/marco`)/totalDias;
const freeze=fs.existsSync(`${RAIZ}/reports/baseline-marco-frozen.json`)?1:0;
const h2=conta(`${RAIZ}/reports/marco-h2`)/totalDias;
const h1=conta(`${RAIZ}/reports/marco-h1`)/totalDias;
const h1h2=conta(`${RAIZ}/reports/marco-h1h2`)/totalDias;
const pct=8*fronteirasPct+48*Math.min(1,base)+1*freeze+15*Math.min(1,h2)+14*Math.min(1,h1)+14*Math.min(1,h1h2);
const etapa=fronteirasPct<1?`fronteiras ${(100*fronteirasPct).toFixed(0)}%`:
  base<1?`baseline ${conta(`${RAIZ}/reports/marco`)}/${totalDias} dias`:
  freeze<1?"congelando":
  h2<1?`H2 ${conta(`${RAIZ}/reports/marco-h2`)}/${totalDias}`:
  h1<1?`H1 ${conta(`${RAIZ}/reports/marco-h1`)}/${totalDias}`:
  h1h2<1?`H1H2 ${conta(`${RAIZ}/reports/marco-h1h2`)}/${totalDias}`:"FIM";
console.log(`${Math.round(pct)}|${etapa}`);
' LOGF="$D/marco-fronteiras.log" 2>/dev/null)
  N="${PCT%%|*}"; ETAPA="${PCT#*|}"
  if [ -n "$N" ] && [ "$N" != "$ULTIMO" ]; then
    echo "PROGRESSO ${N}% — ${ETAPA} ($(date '+%H:%M'))"
    ULTIMO="$N"
  fi
  [ "$ETAPA" = "FIM" ] && { echo "PROGRESSO 100% — cadeia do marco CONCLUIDA"; break; }
  sleep 60
done
