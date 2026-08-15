import fs from 'fs';
import path from 'path';

// Let's inspect the GLB files header and JSON chunk
const dir = path.resolve('public/models');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.glb'));

for (const file of files) {
  const filePath = path.join(dir, file);
  const buffer = fs.readFileSync(filePath);
  
  const magic = buffer.readUInt32LE(0);
  const version = buffer.readUInt32LE(4);
  const length = buffer.readUInt32LE(8);
  const jsonChunkLength = buffer.readUInt32LE(12);
  const jsonChunkType = buffer.readUInt32LE(16);
  
  const jsonStr = buffer.toString('utf8', 20, 20 + jsonChunkLength);
  try {
    const gltf = JSON.parse(jsonStr);
    console.log(`\n=== ${file} (${(buffer.length / 1024 / 1024).toFixed(2)} MB) ===`);
    console.log('Nodes:', gltf.nodes?.map(n => n.name) || []);
    console.log('Meshes count:', gltf.meshes?.length || 0);
    console.log('Materials count:', gltf.materials?.length || 0);
    if (gltf.materials) {
      console.log('Materials:', gltf.materials.map(m => m.name || 'unnamed'));
    }
    if (gltf.animations) {
      console.log('Animations:', gltf.animations.length);
    }
  } catch (e) {
    console.error(`Error parsing ${file}:`, e);
  }
}
