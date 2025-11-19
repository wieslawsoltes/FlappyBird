const SPRITE_SHADER_WGSL = `
struct Uniforms {
    resolution: vec2f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var mySampler: sampler;
@group(0) @binding(2) var myTexture: texture_2d<f32>;

struct VertexInput {
    @location(0) position: vec2f,
    @location(1) uv: vec2f,
    @location(2) instancePos: vec2f,
    @location(3) instanceSize: vec2f,
    @location(4) instanceRotation: f32,
    @location(5) instanceUVOffset: vec4f, // xy: offset, zw: size
}

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    
    // Rotate
    let c = cos(input.instanceRotation);
    let s = sin(input.instanceRotation);
    let rotatedPos = vec2f(
        input.position.x * c - input.position.y * s,
        input.position.x * s + input.position.y * c
    );
    
    // Scale and Translate
    let worldPos = rotatedPos * input.instanceSize + input.instancePos;
    
    // Convert to Clip Space (-1 to 1)
    // Screen is 0..width, 0..height. 
    // x: 0 -> -1, width -> 1
    // y: 0 -> 1, height -> -1 (flip Y for WebGPU)
    
    let clipX = (worldPos.x / uniforms.resolution.x) * 2.0 - 1.0;
    let clipY = -((worldPos.y / uniforms.resolution.y) * 2.0 - 1.0);
    
    output.position = vec4f(clipX, clipY, 0.0, 1.0);
    
    // UV mapping for atlas
    // input.uv is 0..1
    // we want to map it to instanceUVOffset.xy .. instanceUVOffset.xy + instanceUVOffset.zw
    output.uv = input.instanceUVOffset.xy + input.uv * input.instanceUVOffset.zw;
    
    return output;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(myTexture, mySampler, uv);
}
`;

const PARTICLE_SHADER_WGSL = `
struct Uniforms {
    resolution: vec2f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
    @location(0) position: vec2f,
    @location(1) color: vec4f,
    @location(2) size: f32,
}

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    
    // Simple point sprite logic or just points
    // For simplicity, we'll use GL_POINT equivalent if possible, but WebGPU uses quads usually.
    // Here we assume the input position is the center, and we expand in vertex shader? 
    // No, let's assume we draw 6 vertices per particle (quad) or use instancing.
    // To keep it simple, let's just draw large points? WebGPU doesn't support point size in all implementations easily.
    // Let's stick to instanced quads for particles too, but for now, let's just use the sprite shader for particles with a white texture and tint?
    // Actually, let's just reuse the sprite shader for particles and use a small white circle texture.
    
    return output;
}
`;

const POST_PROCESS_SHADER_WGSL = `
struct Uniforms {
    resolution: vec2f,
    time: f32,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var mySampler: sampler;
@group(0) @binding(2) var myTexture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
        vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
    );
    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = pos[vertexIndex] * 0.5 + 0.5;
    output.uv.y = 1.0 - output.uv.y; // Flip Y
    return output;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    // CRT Effect
    
    // 1. Curvature (Barrel Distortion)
    let uv_centered = uv - 0.5;
    let dist = length(uv_centered);
    let uv_distorted = uv_centered * (1.0 + 0.1 * dist * dist) + 0.5;
    
    if (uv_distorted.x < 0.0 || uv_distorted.x > 1.0 || uv_distorted.y < 0.0 || uv_distorted.y > 1.0) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    
    // 2. Chromatic Aberration
    let offset = 0.003 * (1.0 + dist * 2.0);
    let r = textureSampleLevel(myTexture, mySampler, uv_distorted + vec2f(offset, 0.0), 0.0).r;
    let g = textureSampleLevel(myTexture, mySampler, uv_distorted, 0.0).g;
    let b = textureSampleLevel(myTexture, mySampler, uv_distorted - vec2f(offset, 0.0), 0.0).b;
    
    var color = vec3f(r, g, b);
    
    // 3. Scanlines
    let scanline = sin(uv_distorted.y * uniforms.resolution.y * 0.5 + uniforms.time * 5.0) * 0.1 + 0.9;
    color = color * scanline;
    
    // 4. Vignette
    let vignette = 1.0 - dist * 0.5;
    color = color * vignette;
    
    // 5. Color Boost
    color = pow(color, vec3f(0.9)); // Gamma correction-ish
    color = color * 1.1; // Brightness
    
    return vec4f(color, 1.0);
}
`;

class WebGPURenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('webgpu');
        this.device = null;
        this.pipeline = null;
        this.uniformBuffer = null;
        this.texture = null;
        this.sampler = null;
        this.bindGroup = null;
        
        // Post Process
        this.postProcessPipeline = null;
        this.postProcessBindGroup = null;
        this.sceneTexture = null;
        this.sceneTextureView = null;
        this.postProcessUniformBuffer = null;
        
        // Buffers
        this.quadVertexBuffer = null;
        this.instanceBuffer = null;
        this.instanceData = new Float32Array(1000 * 12); // Max 1000 sprites, 12 floats each
        this.instanceCount = 0;
        
        // Atlas definitions
        this.atlas = {
            width: 512,
            height: 512,
            regions: {}
        };
        
        this.particles = [];
    }

    async init() {
        if (!navigator.gpu) return false;
        
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return false;
        
        this.device = await adapter.requestDevice();
        
        this.ctx.configure({
            device: this.device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'premultiplied',
        });

        await this.createAssets();
        this.createPipeline();
        this.createPostProcessPipeline();
        
        return true;
    }

    createPostProcessPipeline() {
        // Scene Texture (Render Target)
        this.sceneTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: navigator.gpu.getPreferredCanvasFormat(),
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.sceneTextureView = this.sceneTexture.createView();

        // Uniforms
        this.postProcessUniformBuffer = this.device.createBuffer({
            size: 16, // vec2f resolution + f32 time + padding
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const module = this.device.createShaderModule({ code: POST_PROCESS_SHADER_WGSL });

        this.postProcessPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module,
                entryPoint: 'vs_main',
            },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{
                    format: navigator.gpu.getPreferredCanvasFormat(),
                }]
            },
            primitive: {
                topology: 'triangle-list',
            }
        });

        this.postProcessBindGroup = this.device.createBindGroup({
            layout: this.postProcessPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.postProcessUniformBuffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: this.sceneTextureView },
            ]
        });
    }

    async createAssets() {
        // Create a texture atlas from the 2D drawing commands
        const offscreen = document.createElement('canvas');
        offscreen.width = this.atlas.width;
        offscreen.height = this.atlas.height;
        const ctx = offscreen.getContext('2d');
        
        // Helper to record region
        const addRegion = (name, x, y, w, h, drawFn) => {
            ctx.save();
            ctx.translate(x, y);
            drawFn(ctx, w, h);
            ctx.restore();
            // Normalize UVs
            this.atlas.regions[name] = {
                uvOffset: [x / this.atlas.width, y / this.atlas.height],
                uvSize: [w / this.atlas.width, h / this.atlas.height]
            };
        };

        // 1. Bird (50x50 space)
        addRegion('bird', 0, 0, 50, 50, (c, w, h) => {
            c.translate(w/2, h/2);
            // Draw bird (copied from script.js logic roughly)
            // Body
            c.fillStyle = '#FFD700';
            c.beginPath(); c.arc(0, 0, 12, 0, Math.PI * 2); c.fill();
            c.strokeStyle = '#000'; c.lineWidth = 2; c.stroke();
            // Eye
            c.fillStyle = '#FFF'; c.beginPath(); c.arc(6, -6, 6, 0, Math.PI * 2); c.fill(); c.stroke();
            c.fillStyle = '#000'; c.beginPath(); c.arc(8, -6, 2, 0, Math.PI * 2); c.fill();
            // Beak
            c.fillStyle = '#FFA500'; c.beginPath(); c.moveTo(6, 2); c.lineTo(16, 6); c.lineTo(6, 10); c.fill(); c.stroke();
            // Wing
            c.fillStyle = '#F0E68C'; c.beginPath(); c.ellipse(-4, 4, 8, 5, 0.2, 0, Math.PI * 2); c.fill(); c.stroke();
        });

        // 2. Pipe Body (50x100 - repeatable vertically?) 
        // Actually we can just stretch a 50x50 block for the pipe body
        addRegion('pipe-body', 60, 0, 50, 50, (c, w, h) => {
            c.fillStyle = '#73BF2E';
            c.fillRect(0, 0, w, h);
            c.strokeStyle = '#558C22';
            c.lineWidth = 4;
            c.strokeRect(0, 0, w, h);
            // Highlights
            c.fillStyle = 'rgba(255,255,255,0.1)';
            c.fillRect(2, 0, 4, h);
        });

        // 3. Pipe Cap (54x20)
        addRegion('pipe-cap', 60, 60, 54, 20, (c, w, h) => {
            c.fillStyle = '#73BF2E';
            c.fillRect(0, 0, w, h);
            c.strokeStyle = '#558C22';
            c.lineWidth = 2;
            c.strokeRect(0, 0, w, h);
        });

        // 4. Cloud (100x60)
        addRegion('cloud', 0, 100, 100, 60, (c, w, h) => {
            c.fillStyle = '#FFF';
            c.beginPath();
            c.arc(30, 30, 20, 0, Math.PI * 2);
            c.arc(50, 25, 25, 0, Math.PI * 2);
            c.arc(70, 30, 20, 0, Math.PI * 2);
            c.fill();
        });

        // 5. Ground (50x50 pattern)
        addRegion('ground', 120, 0, 50, 50, (c, w, h) => {
            c.fillStyle = '#DED895';
            c.fillRect(0, 0, w, h);
            c.fillStyle = '#73BF2E';
            c.fillRect(0, 0, w, 10); // Grass top
            c.strokeStyle = '#CBB968';
            c.lineWidth = 2;
            c.beginPath();
            c.moveTo(10, 10); c.lineTo(0, 20);
            c.moveTo(30, 10); c.lineTo(20, 20);
            c.moveTo(50, 10); c.lineTo(40, 20);
            c.stroke();
        });

        // 6. Particle (White Circle)
        addRegion('particle', 180, 0, 20, 20, (c, w, h) => {
            c.fillStyle = '#FFF';
            c.beginPath();
            c.arc(10, 10, 8, 0, Math.PI * 2);
            c.fill();
        });

        // Upload texture
        const imageData = ctx.getImageData(0, 0, this.atlas.width, this.atlas.height);
        this.texture = this.device.createTexture({
            size: [this.atlas.width, this.atlas.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        
        this.device.queue.writeTexture(
            { texture: this.texture },
            imageData.data,
            { bytesPerRow: this.atlas.width * 4 },
            [this.atlas.width, this.atlas.height]
        );

        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });
    }

    createPipeline() {
        // Quad Geometry (Centered at 0,0, size 1x1)
        // x, y, u, v
        const vertices = new Float32Array([
            -0.5, -0.5, 0, 1,
             0.5, -0.5, 1, 1,
            -0.5,  0.5, 0, 0,
             0.5,  0.5, 1, 0,
        ]);
        
        this.quadVertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.quadVertexBuffer, 0, vertices);

        // Instance Buffer (Dynamic)
        this.instanceBuffer = this.device.createBuffer({
            size: this.instanceData.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        // Uniform Buffer
        this.uniformBuffer = this.device.createBuffer({
            size: 8, // vec2f resolution
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const module = this.device.createShaderModule({ code: SPRITE_SHADER_WGSL });

        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module,
                entryPoint: 'vs_main',
                buffers: [
                    // Quad Vertex
                    {
                        arrayStride: 4 * 4,
                        stepMode: 'vertex',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // pos
                            { shaderLocation: 1, offset: 8, format: 'float32x2' }, // uv
                        ]
                    },
                    // Instance Data
                    {
                        arrayStride: 12 * 4,
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 2, offset: 0, format: 'float32x2' }, // pos
                            { shaderLocation: 3, offset: 8, format: 'float32x2' }, // size
                            { shaderLocation: 4, offset: 16, format: 'float32' },  // rotation
                            { shaderLocation: 5, offset: 20, format: 'float32x4' }, // uv offset/size
                        ]
                    }
                ]
            },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{
                    format: navigator.gpu.getPreferredCanvasFormat(),
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    }
                }]
            },
            primitive: {
                topology: 'triangle-strip',
            }
        });

        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: this.texture.createView() },
            ]
        });
    }

    // Add a sprite to the batch
    drawSprite(name, x, y, w, h, rotation = 0) {
        if (this.instanceCount >= 1000) return;
        
        const region = this.atlas.regions[name];
        if (!region) return;

        const i = this.instanceCount * 12;
        this.instanceData[i] = x;
        this.instanceData[i+1] = y;
        this.instanceData[i+2] = w;
        this.instanceData[i+3] = h;
        this.instanceData[i+4] = rotation;
        this.instanceData[i+5] = region.uvOffset[0];
        this.instanceData[i+6] = region.uvOffset[1];
        this.instanceData[i+7] = region.uvSize[0];
        this.instanceData[i+8] = region.uvSize[1];
        // Padding/Extra data if needed
        
        this.instanceCount++;
    }

    addParticle(x, y) {
        this.particles.push({
            x, y,
            vx: (Math.random() - 0.5) * 4,
            vy: (Math.random() - 0.5) * 4,
            life: 1.0
        });
    }

    updateParticles() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            let p = this.particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.life -= 0.02;
            if (p.life <= 0) {
                this.particles.splice(i, 1);
            } else {
                // Draw particle
                // Use 'particle' region, scale by life
                this.drawSprite('particle', p.x, p.y, 10 * p.life, 10 * p.life, 0);
            }
        }
    }

    render(gameState) {
        if (!this.device || !this.pipeline || !this.postProcessPipeline) return;

        // Resize scene texture if needed
        if (this.sceneTexture.width !== this.canvas.width || this.sceneTexture.height !== this.canvas.height) {
            this.sceneTexture.destroy();
            this.sceneTexture = this.device.createTexture({
                size: [this.canvas.width, this.canvas.height],
                format: navigator.gpu.getPreferredCanvasFormat(),
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this.sceneTextureView = this.sceneTexture.createView();
            
            // Recreate bind group
            this.postProcessBindGroup = this.device.createBindGroup({
                layout: this.postProcessPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.postProcessUniformBuffer } },
                    { binding: 1, resource: this.sampler },
                    { binding: 2, resource: this.sceneTextureView },
                ]
            });
        }

        // Update Uniforms
        this.device.queue.writeBuffer(
            this.uniformBuffer, 
            0, 
            new Float32Array([this.canvas.width, this.canvas.height])
        );
        
        this.device.queue.writeBuffer(
            this.postProcessUniformBuffer,
            0,
            new Float32Array([this.canvas.width, this.canvas.height, performance.now() / 1000, 0])
        );

        // Clear batch
        this.instanceCount = 0;

        // 1. Background (Just clear color in pass, or draw a big quad)
        // We'll rely on clearValue in renderPass for sky color

        // 2. Clouds
        // Static clouds for now, hardcoded positions from script.js
        this.drawSprite('cloud', 100, 350, 100, 60);
        this.drawSprite('cloud', 250, 100, 100, 60);

        // 3. Pipes
        gameState.pipes.forEach(p => {
            // Top Pipe
            // Body
            this.drawSprite('pipe-body', p.x + 25, p.top / 2, 50, p.top); 
            // Cap
            this.drawSprite('pipe-cap', p.x + 25, p.top - 10, 54, 20);

            // Bottom Pipe
            const bottomH = this.canvas.height - p.bottom;
            // Body
            this.drawSprite('pipe-body', p.x + 25, this.canvas.height - p.bottom / 2, 50, p.bottom);
            // Cap
            this.drawSprite('pipe-cap', p.x + 25, this.canvas.height - p.bottom + 10, 54, 20);
        });

        // 4. Ground
        // Tiling ground
        const groundY = this.canvas.height - 10;
        for (let x = gameState.groundX; x < this.canvas.width; x += 50) {
            this.drawSprite('ground', x + 25, groundY, 50, 20);
        }
        // Fill gap at end if needed
        if (gameState.groundX % 50 !== 0) {
             this.drawSprite('ground', gameState.groundX + Math.ceil((this.canvas.width - gameState.groundX)/50)*50 + 25, groundY, 50, 20);
        }

        // 5. Bird
        this.drawSprite('bird', gameState.bird.x, gameState.bird.y, 24, 24, gameState.bird.rotation);

        // 6. Particles
        this.updateParticles();

        // Upload Instance Data
        this.device.queue.writeBuffer(
            this.instanceBuffer, 
            0, 
            this.instanceData, 
            0, 
            this.instanceCount * 12
        );

        // Render Pass 1: Scene to Texture
        const commandEncoder = this.device.createCommandEncoder();
        
        const scenePassDescriptor = {
            colorAttachments: [{
                view: this.sceneTextureView,
                clearValue: { r: 0.44, g: 0.77, b: 0.81, a: 1.0 }, // Sky blue #70c5ce
                loadOp: 'clear',
                storeOp: 'store',
            }],
        };

        const passEncoder = commandEncoder.beginRenderPass(scenePassDescriptor);
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, this.bindGroup);
        passEncoder.setVertexBuffer(0, this.quadVertexBuffer);
        passEncoder.setVertexBuffer(1, this.instanceBuffer);
        passEncoder.draw(4, this.instanceCount);
        passEncoder.end();

        // Render Pass 2: Post Process to Screen
        const textureView = this.ctx.getCurrentTexture().createView();
        const postPassDescriptor = {
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        };
        
        const postPassEncoder = commandEncoder.beginRenderPass(postPassDescriptor);
        postPassEncoder.setPipeline(this.postProcessPipeline);
        postPassEncoder.setBindGroup(0, this.postProcessBindGroup);
        postPassEncoder.draw(6); // Draw 6 vertices (2 triangles) for full screen quad
        postPassEncoder.end();

        this.device.queue.submit([commandEncoder.finish()]);
    }
}
