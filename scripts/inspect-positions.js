import fs from 'fs';
import path from 'path';

const dir = path.resolve('public/models');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.glb'));

for (const file of files) {
  const filePath = path.join(dir, file);
  const buffer = fs.readFileSync(filePath);
  const jsonChunkLength = buffer.readUInt32LE(12);
  const jsonStr = buffer.toString('utf8', 20, 20 + jsonChunkLength);
  const gltf = JSON.parse(jsonStr);

  console.log(`\n=== ${file} ===`);
  if (gltf.meshes) {
    gltf.meshes.forEach((mesh, idx) => {
      console.log(` Mesh ${idx} (${mesh.name || 'unnamed'}):`);
      mesh.primitives.forEach((prim, pIdx) => {
        const posAccIdx = prim.attributes.POSITION;
        const accessor = gltf.accessors[posAccIdx];
        console.log(`   Prim ${pIdx} Pos min:`, accessor.min, 'max:', accessor.max);
      });
    });
  }
}
