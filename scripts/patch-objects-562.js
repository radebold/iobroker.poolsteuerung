'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');

// Alle bisherigen Patches beibehalten.
require('./patch-objects-561.js');

const ioFile=path.join(root,'io-package.json');
const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.62';
io.common=io.common||{};
io.common.version='0.5.62';
fs.writeFileSync(ioFile,JSON.stringify(io,null,2)+'\n');

const rel='build/main-ipadmini-final-047.js';
const file=path.join(root,rel);
if(!fs.existsSync(file)) throw new Error(`[0.5.62] Datei fehlt: ${rel}`);
let src=fs.readFileSync(file,'utf8');

const oldCheck=`      const ipad = await adapter.getStateAsync('vis.htmlIpadMini');\n      const html = String((ipad && ipad.val) || '');\n      if (!html.includes('data-dose=\\"60\\"') || !html.includes('onclick=\\"') || html.includes('<script data-ipad-final=\\"1\\">')) {\n        throw new Error('iPad-Dosierhandler wurde nicht vollständig erzeugt');\n      }`;

const newCheck=`      const ipad = await adapter.getStateAsync('vis.htmlIpadMini');\n      const html = String((ipad && ipad.val) || '');\n\n      // 0.4.47 war ausschliesslich fuer die damalige Legacy-iPad-Seite gedacht.\n      // Moderne Pool-VIS verwenden eine andere HTML-/Event-Struktur und duerfen\n      // deshalb nicht mehr gegen data-dose/onclick aus 0.4.47 validiert werden.\n      const isLegacyIpad047 = html.includes('data-ipad-final=\\"1\\"') && html.includes('data-dose=\\"60\\"');\n      if (isLegacyIpad047 && (!html.includes('onclick=\\"') || html.includes('<script data-ipad-final=\\"1\\">'))) {\n        throw new Error('Legacy-iPad-Dosierhandler 0.4.47 wurde nicht vollständig erzeugt');\n      }`;

if(src.includes(oldCheck)){
  src=src.replace(oldCheck,newCheck);
}else if(!src.includes('const isLegacyIpad047 =')){
  throw new Error('[0.5.62] Validierungsblock in 0.4.47 nicht gefunden; Patch abgebrochen');
}

fs.writeFileSync(file,src);
console.log('[0.5.62] 0.4.47-Dosierhandler-Validierung auf echte Legacy-iPad-Seiten begrenzt');
