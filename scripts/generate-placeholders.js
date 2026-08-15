import fs from 'fs';
import path from 'path';

const bodies = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune'
];

const outputDir = path.resolve('public/models');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Minimal glTF JSON representation of a single triangle
const gltfJson = {
  asset: {
    version: '2.0'
  },
  scene: 0,
  scenes: [
    {
      nodes: [0]
    }
  ],
  nodes: [
    {
      mesh: 0
    }
  ],
  meshes: [
    {
      primitives: [
        {
          attributes: {
            POSITION: 1
          },
          indices: 0
        }
      ]
    }
  ],
  bufferViews: [
    {
      buffer: 0,
      byteOffset: 0,
      byteLength: 6,
      target: 34963 // ELEMENT_ARRAY_BUFFER
    },
    {
      buffer: 0,
      byteOffset: 8, // 4-byte aligned
      byteLength: 36,
      target: 34962 // ARRAY_BUFFER
    }
  ],
  accessors: [
    {
      bufferView: 0,
      byteOffset: 0,
      componentType: 5123, // UNSIGNED_SHORT
      count: 3,
      type: 'SCALAR'
    },
    {
      bufferView: 1,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: 3,
      type: 'VEC3',
      max: [1.0, 1.0, 0.0],
      min: [0.0, 0.0, 0.0]
    }
  ],
  buffers: [
    {
      byteLength: 44
    }
  ]
};

// Binary buffer: 3 indices (uint16: 0, 1, 2) + 3 vertices (float32 x,y,z: [0,0,0], [1,0,0], [0,1,0])
const indices = new Uint16Array([0, 1, 2]);
const vertices = new Float32Array([
  0.0, 0.0, 0.0,
  1.0, 0.0, 0.0,
  0.0, 1.0, 0.0
]);

const binBuffer = Buffer.alloc(44);
Buffer.from(indices.buffer).copy(binBuffer, 0);
Buffer.from(vertices.buffer).copy(binBuffer, 8); // pad offset to 8

function createGlb() {
  const jsonStr = JSON.stringify(gltfJson);
  const jsonLength = Buffer.byteLength(jsonStr);
  const jsonPadding = (4 - (jsonLength % 4)) % 4;
  const jsonChunkLength = jsonLength + jsonPadding;

  const binLength = binBuffer.length;
  const binPadding = (4 - (binLength % 4)) % 4;
  const binChunkLength = binLength + binPadding;

  const totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength;

  const glb = Buffer.alloc(totalLength);

  // Header
  glb.writeUInt32LE(0x46546C67, 0); // magic "glTF"
  glb.writeUInt32LE(2, 4);          // version 2
  glb.writeUInt32LE(totalLength, 8); // total length

  // JSON Chunk Header
  glb.writeUInt32LE(jsonChunkLength, 12);
  glb.writeUInt32LE(0x4E4F534A, 16); // chunk type "JSON"
  
  // JSON Chunk Data
  glb.write(jsonStr, 20);
  for (let i = 0; i < jsonPadding; i++) {
    glb.write(' ', 20 + jsonLength + i);
  }

  // BIN Chunk Header
  const binHeaderOffset = 20 + jsonChunkLength;
  glb.writeUInt32LE(binChunkLength, binHeaderOffset);
  glb.writeUInt32LE(0x004E4942, binHeaderOffset + 4); // chunk type "BIN"

  // BIN Chunk Data
  binBuffer.copy(glb, binHeaderOffset + 8);
  for (let i = 0; i < binPadding; i++) {
    glb.writeUInt8(0, binHeaderOffset + 8 + binLength + i);
  }

  return glb;
}

const glbBuffer = createGlb();

bodies.forEach((body) => {
  const filePath = path.join(outputDir, `${body}.glb`);
  fs.writeFileSync(filePath, glbBuffer);
  console.log(`Created placeholder GLB: ${filePath}`);
});
