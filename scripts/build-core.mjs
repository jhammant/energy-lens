import { mkdir,copyFile } from 'node:fs/promises';
const root=new URL('../',import.meta.url);
await mkdir(new URL('dist/',root),{recursive:true});
for(const file of ['engine.mjs','tariffs.mjs'])await copyFile(new URL(`core/${file}`,root),new URL(`dist/${file}`,root));
