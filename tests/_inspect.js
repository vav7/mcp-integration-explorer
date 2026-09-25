const fs=require("fs");
const src=fs.readFileSync(__dirname+"/render_smoke.js","utf8")
  .replace("process.exit(0);","global.__reg=reg;setTimeout(check,50);")
  .replace("process.exit(1);","global.__reg=reg;setTimeout(check,50);")
  + "\nfunction check(){const reg=global.__reg;const view=reg['#viewContent'].innerHTML;const modal=reg['#modal'].innerHTML;"
  + "console.log('explorer rows with --rowbg (want 0):',(view.match(/--rowbg:/g)||[]).length);"
  + "console.log('modal findComm (want false):',modal.includes('findComm'));"
  + "console.log('modal ci-row count:',(modal.match(/class=\"ci-row\"/g)||[]).length);"
  + "console.log('modal rcomp rows with tint:',(modal.match(/rcomp-row\" style=\"--rowbg/g)||[]).length);"
  + "console.log('modal official srvcard:',modal.includes('srvcard official'));"
  + "console.log('drawer chips synced (dwChips touched):', !!reg['#dwChips']);}" ;
eval(src);
