
'use strict';
function parseTimes(csv){return String(csv||'').split(',').map(s=>s.trim()).filter(Boolean);}
function hhmm(){const d=new Date();return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
module.exports={parseTimes,hhmm};
