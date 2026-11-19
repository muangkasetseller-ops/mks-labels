// node test/run.js <file.csv> [mode]
const fs=require('fs'),vm=require('vm');
global.window=global;
for(const f of ['data/products.js','data/aliases.js']) vm.runInThisContext(fs.readFileSync(f,'utf8'));
const C=require('../core.js');
const buf=fs.readFileSync(process.argv[2]);
const rows=C.parseCsvText(C.decodeBuffer(buf));
const os=C.buildOrders(rows,{aliases:TRANSPORT_ALIASES,bySku:PRODUCTS_BY_SKU,byName:PRODUCTS_BY_NAME,mode:process.argv[3]||'perItem'});
for(const o of os) console.log(o.no,'|',o.transport,'|',o.name,'|',o.phone,'|',o.pieces,'ชิ้น','|',o.address.slice(0,40),'|',o.warn.join(';'),o.nosender?'[nosender]':'');
