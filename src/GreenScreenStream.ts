
import { DR } from 'demolishedrenderer';
import quantize from 'quantize'

const bodyPix = require('@tensorflow-models/body-pix');
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu'
import { dispose } from '@tensorflow/tfjs-core';

import { GreenScreenConfig } from './models/green-screen-config.interface';
import { DEFAULT_MASK_SETTINGS, MaskSettings } from './models/masksettings.interface';
import { BUFFER_FRAG, BUFFER_VERT, MAIN_FRAG, MAIN_VERT } from './models/glsl-constants';
import { TextureSettings } from './models/texturesettings.interface';
import { GreenScreenMethod } from './models/green-screen-method.enum';
import { BodyPixConfig } from './models/bodypix-config.interface';
import { getBodyPixMode } from './utils/get-bodypix-mode.util';
import { asyncCall } from './utils/async-call.util';

export class GreenScreenStream {
    isRendering: boolean;
    frame: number = -1;
    rafId: number;
    startTime: number = null;
    opacity: any;
    flipHorizontal: any;
    maskBlurAmount: any;
    foregroundColor: any;
    backgroundColor: any;
    ctx: any;
    demolished: DR;
    mediaStream: MediaStream;
    model: any;
    private segmentConfig: any;
    private backgroundSource: any;
    private sourceVideo: HTMLVideoElement;
    private cameraSource: HTMLVideoElement | HTMLCanvasElement;
    private chromaKey = { r: 0.0, g: 0.6941176470588235, b: 0.25098039215686274 } // { r: 0, g: 177, b: 64
    private maskRange = { x: 0.0025, y: 0.26 }
    private useML: boolean;

    mainFrag: string = MAIN_FRAG;

    mainVert: string = MAIN_VERT;

    bufferVert: string = BUFFER_VERT;

    bufferFrag: string = BUFFER_FRAG;
    maxFps: number;

    canvas:HTMLCanvasElement | OffscreenCanvas;
    offscreen : OffscreenCanvas;
    modelLoaded: boolean;

    constructor(
        public greenScreenMethod: GreenScreenMethod, 
        public canvasEl?: HTMLCanvasElement, 
        width: number = 640,
        height: number = 360
    ) {
        this.mediaStream = new MediaStream();
        if (canvasEl)
            this.canvas =  canvasEl
        else 
            this.canvas = document.createElement("canvas") as HTMLCanvasElement;
   
        this.canvas.width = width; this.canvas.height = height;

        if (greenScreenMethod !== GreenScreenMethod.VirtualBackgroundUsingGreenScreen)
                this.useML = true;
    }

    /**
     * Set the background
     *
     * @param {string} src
     * @return {*}  {(Promise<HTMLImageElement | HTMLVideoElement | Error>)}
     * @memberof GreenScreenStream
     */
    setBackground(src: string): Promise<HTMLImageElement | HTMLVideoElement | Error> {
        return new Promise<any>((resolve, reject) => {
            const isImage = src.match(/\.(jpeg|jpg|png)$/) !== null;
            if (isImage) {
                const bg = new Image();
                bg.onerror = () => {
                    reject(new Error(`Unable to background image from ${src}`))
                };
                bg.onload = () => {
                    this.backgroundSource = bg;
                    resolve(bg);
                }
                bg.src = src;
            } else {
                const bg = document.createElement("video");
                bg.autoplay = true;
                bg.loop = true;
                bg.onerror = () => {
                    reject(new Error(`Unable to load background video from ${src}`))
                };
                bg.onloadeddata = () => {
                    this.backgroundSource = bg;
                    resolve(bg);
                }
                bg.src = src;
            }
        });
    }
    /**
     * Set up the rendering, texturesx etc.
     *
     * @private
     * @param {string} [backgroundUrl]
     * @return {*}  {Promise<boolean | Error>}
     * @memberof GreenScreenStream
     */
    private setupRenderer(backgroundUrl: string): Promise<boolean | Error> {
        return new Promise<boolean | Error>(async (resolve, reject) => {
            this.ctx = this.canvas.getContext("webgl2");
            await this.setBackground(backgroundUrl).catch(err => {
                reject(err);
            });

            const textureSettings: TextureSettings = this.getTextureSettings();

            await this.prepareRenderer(textureSettings).catch(err => {
                reject(new Error("Cannot setup renderer"))
            });
            resolve(true);
        });
    }

    /**
     * Get the necessary texture settings
     */
    private getTextureSettings(): TextureSettings {
        return {
            "background": {
                //unit: 33985,
                fn: (_prg: WebGLProgram, gl: WebGLRenderingContext, texture: WebGLTexture) => {
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texImage2D(3553, 0, 6408, 6408, 5121, this.backgroundSource);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                }
            },
            "webcam": {
                //unit: 33986,
                fn: (_prg: WebGLProgram, gl: WebGLRenderingContext, texture: WebGLTexture) => {
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texImage2D(3553, 0, 6408, 6408, 5121, this.cameraSource);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                }
            }
        }

    }

    /**
     * Instantiates & prepares the demolishedRenderer 
     * @param textureSettings
     */
    private prepareRenderer(textureSettings: TextureSettings): Promise<boolean | Error> {
        return new Promise<boolean | Error>(async (resolve, reject) => {
            try {
                this.demolished = new DR(this.canvas as any, this.mainVert, this.mainFrag);
                this.demolished.aA(
                    textureSettings
                    , () => {
                        this.demolished.aB(
                            "A",
                            this.mainVert,
                            this.bufferFrag,
                            ["background", "webcam"],
                            {
                                "chromaKey": (
                                    location: WebGLUniformLocation,
                                    gl: WebGLRenderingContext,
                                    p: WebGLProgram,
                                    timestamp: number
                                ) => {
                                    gl.uniform4f(
                                        location,
                                        this.chromaKey.r,
                                        this.chromaKey.g,
                                        this.chromaKey.b,
                                        1.
                                    )
                                },
                                "maskRange": (
                                    location: WebGLUniformLocation,
                                    gl: WebGLRenderingContext,
                                    p: WebGLProgram,
                                    timestamp: number
                                ) => {
                                    gl.uniform2f(
                                        location,
                                        this.maskRange.x,
                                        this.maskRange.y
                                    )
                                }
                            }
                        );
                        resolve(true);
                    });
            } catch (err) {
                reject(new Error(err));
            }

        });
    }

    /**
     * Set the color to be removed
     * i.e (0.05,0.63,0.14)
     * @param {number} r  0.0 - 1.0
     * @param {number} g 0.0 - 1.0
     * @param {number} b 0.0 - 1.0
     * @memberof GreenScreenStream
     */
    setChromaKey(r: number, g: number, b: number) {
        this.chromaKey.r = r;
        this.chromaKey.g = g;
        this.chromaKey.b = b;
    }

    /**
     * Range is used to decide the amount of color to be used from either foreground or background.
     * Playing with this variable will decide how much the foreground and background blend together.
     * @param {number} x
     * @param {number} y
     * @memberof GreenScreenStream
     */
    setMaskRange(x: number, y: number) {
        this.maskRange.x = x;
        this.maskRange.y = y;
    }

    /**
     * Get the most dominant color and a list (palette) of the colors most common in the provided MediaStreamTrack
     *
     * @returns {{ palette: any, dominant: any }}
     * @memberof GreenScreenStream
     */
    getColorsFromStream(): { palette: any, dominant: any } {
        let glCanvas = this.canvas;
        let tempCanvas = document.createElement("canvas");
        tempCanvas.width = glCanvas.width;
        tempCanvas.height = glCanvas.height;
        let ctx = tempCanvas.getContext("2d");
        ctx.drawImage(this.sourceVideo, 0, 0);

        let imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);

        const pixels = this.canvas.width * this.canvas.height;

        return {
            palette: this.pallette(imageData, pixels),
            dominant: this.dominant(imageData, pixels)
        }
    }
    /**
     * Start render
     *
     * @param {number} [maxFps] maximum frame rate, defaults to 60fps
     * @memberof GreenScreenStream
     */
    start(maxFps?: number) {
        this.maxFps = maxFps || 60;
        this.isRendering = true;
        const canvas = document.createElement("canvas");
        switch (this.greenScreenMethod) {
            case GreenScreenMethod.VirtualBackgroundUsingGreenScreen:
                this.renderVirtualBackgroundGreenScreen(0);
                break;
            case GreenScreenMethod.VirtualBackground:
                this.cameraSource = canvas;
                this.renderVirtualBackground(0);
                break;
            case GreenScreenMethod.Mask:
                const ctx = canvas.getContext("2d");
                this.renderMask(0, ctx);
                break;
        }
    }

    /**
    * Renders a virtual background using a greenscreen
    * @param t 
    */
    private renderVirtualBackgroundGreenScreen(t: number): void {
        if (!this.isRendering)
            return;
        if (this.startTime == null) this.startTime = t;
        let seg = Math.floor((t - this.startTime) / (1000 / this.maxFps));
        if (seg > this.frame) {
            this.frame = seg;
            this.demolished.R(t / 1000)
        }
        this.rafId = requestAnimationFrame((ts) => this.renderVirtualBackgroundGreenScreen(ts));
    }
    /**
     * Renders a virtual background using ML
     * @param t 
     */
    
    private async renderVirtualBackground(t: number): Promise<void> {
        if (!this.isRendering)
            return;        
        if (this.startTime == null) this.startTime = t;
        let seg = Math.floor((t - this.startTime) / (1000 / this.maxFps));
        if (seg > this.frame) {
            const { error, result } = await asyncCall(this.model.segmentPerson(this.sourceVideo, this.segmentConfig));
            if (error)
                return console.error(error);            
        //    console.time("bodyPix toMask")
            const maskedImage = bodyPix.toMask(result, this.foregroundColor, this.backgroundColor);

            bodyPix.drawMask(
                this.cameraSource,
                this.sourceVideo,
                maskedImage,
                this.opacity,
                this.maskBlurAmount,
                this.flipHorizontal
            );

            this.frame = seg;
            this.demolished.R(t / 1000);
    
            // console.timeLog("bodyPix toMask");
            // console.timeEnd("bodyPix toMask");
        }
        this.rafId = requestAnimationFrame((ts) => this.renderVirtualBackground(ts));
    }

    /**
     * Renders using a mask
     * @param t 
     * @param ctx 
     */
    private async renderMask(t: number, ctx: CanvasRenderingContext2D): Promise<void> {
        if (!this.isRendering)
            return;
        if (this.startTime == null) this.startTime = t;
        let seg = Math.floor((t - this.startTime) / (1000 / this.maxFps));
        if (seg > this.frame) {
            const { error, result } = await asyncCall(this.model.segmentPerson(this.sourceVideo, this.segmentConfig));
            if (error)
                return console.error(error);

            const maskedImage = bodyPix.toMask(result, this.foregroundColor, this.backgroundColor);
            ctx.putImageData(maskedImage, 0, 0);
            this.demolished.R(t / 1000);
        }
        this.rafId = requestAnimationFrame((ts) => this.renderMask(ts, ctx));
    }
    /**
     * Stop renderer 
     * @param {boolean} [stopMediaStreams] 
     * @memberof GreenScreenStream
     */
    stop(stopMediaStreams?: boolean): void {
        this.isRendering = false;
        cancelAnimationFrame(this.rafId);
        this.rafId = - 1;
        if (stopMediaStreams) {
            this.mediaStream.getVideoTracks().forEach(track => {
                track.stop();
            });
            this.ctx = null;
        }
        this.startTime = null;
        this.frame = -1;
    }

    /**
     * Initalize 
     * @param {string} [backgroundUrl]
     * @param {MaskSettings} [config]
     * @return {*}  {Promise<GreenScreenStream>}
     * @memberof GreenScreenStream
     */
    initialize(backgroundUrl?: string, config?: GreenScreenConfig): Promise<GreenScreenStream> {

        this.setConfig(config?.maskSettings);

        return new Promise<GreenScreenStream>(async (resolve, reject) => {

            let result = await asyncCall(this.setupRenderer(backgroundUrl));
            if (result.error)
                reject(result.error);

            if (!this.demolished)
                reject(`No renderer created. Background source must be provided.`);

            if (!this.useML)
                resolve(this);

            const model = await asyncCall(this.loadBodyPixModel(config));
            if (model.error)
                reject(model.error);

            console.log(model.result);
            this.model = model.result;
            resolve(this);
        });
    }

    /**
     * Applies the passed config or sets up a standard config when no config is provided
     */
    private setConfig(config?: MaskSettings): void {
        const defaults = DEFAULT_MASK_SETTINGS;
        this.opacity = config?.opacity || defaults.opacity;
        this.flipHorizontal = config?.flipHorizontal || defaults.flipHorizontal;
        this.maskBlurAmount = config?.maskBlurAmount || defaults.maskBlurAmount;
        this.foregroundColor = config?.foregroundColor || defaults.foregroundColor;
        this.backgroundColor = config?.backgroundColor || defaults.backgroundColor;

        this.segmentConfig = {
            flipHorizontal: config?.segmentPerson.flipHorizontal || defaults.segmentPerson.flipHorizontal,
            internalResolution: config?.segmentPerson.internalResolution || defaults.segmentPerson.internalResolution,
            segmentationThreshold: config?.segmentPerson.segmentationThreshold || defaults.segmentPerson.segmentationThreshold,
            maxDetections: config?.segmentPerson.maxDetections || defaults.segmentPerson.maxDetections,
            quantBytes: config?.segmentPerson.quantBytes || defaults.segmentPerson.quantBytes
        };
    }

    public async setBodyPixModel(config: GreenScreenConfig) {
        const model = await asyncCall(this.loadBodyPixModel(config));
        if (model.error)
            throw model.error;

        this.model = model.result;
    }
    /**
     * Sets up the bodypix model either via custom config or a preset (mode).
     * If neither is provided, a default config is used.
     * @param config 
     */
    private async loadBodyPixModel(config: GreenScreenConfig) {
        let bodyPixMode: BodyPixConfig;

        if (config?.bodyPixConfig)
            bodyPixMode = config?.bodyPixConfig;
        else
            bodyPixMode = getBodyPixMode(config?.bodyPixMode);

        if(this.modelLoaded)
            dispose(bodyPix);

        this.modelLoaded = true;
        return bodyPix.load(bodyPixMode);
    }

    /**
     * Add a MediaStreamTrack track (i.e webcam )
     *
     * @param {MediaStreamTrack} track
     * @return {*}  {Promise<void|any>}
     * @memberof GreenScreenStream
     */
    addVideoTrack(track: MediaStreamTrack): Promise<void | any> {
        return new Promise<void>((resolve, reject) => {
            try {
                this.mediaStream.addTrack(track);
                this.sourceVideo = document.createElement("video");
                this.sourceVideo.width = this.canvas.width;
                this.sourceVideo.height = this.canvas.height;
                this.sourceVideo.autoplay = true;
                this.sourceVideo.srcObject = this.mediaStream;

                this.sourceVideo.onloadeddata = () => {
                    this.sourceVideo.play();
                    this.cameraSource = this.sourceVideo;
                    resolve();
                }

                this.sourceVideo.onerror = (err) => {
                    reject(err);
                }
            }
            catch (error) {
                reject(error)
            }
        })
    }
    /**
     * Capture the rendered result to a MediaStream
     *
     * @param {number} [fps]
     * @returns {MediaStream}
     * @memberof GreenScreenStream
     */
    captureStream(fps?: number): MediaStream {
        try {
            return this.canvas["captureStream"](fps || 25) as MediaStream;      
        } catch (error) {
                throw error;
        }              
    }
    
    private pixelArray(pixels: any, pixelCount: number, quality: number): Array<number> {
        const pixelArray = [];
        for (let i = 0, offset, r, g, b, a; i < pixelCount; i = i + quality) {
            offset = i * 4;
            r = pixels[offset + 0];
            g = pixels[offset + 1];
            b = pixels[offset + 2];
            a = pixels[offset + 3]
            if (typeof a === 'undefined' || a >= 125) {
                if (!(r > 250 && g > 250 && b > 250)) {
                    pixelArray.push([r, g, b]);
                }
            }
        }
        return pixelArray;
    }
    /**
     *  Get the dominant color from the imageData provided
     *
     * @param {ImageData} imageData
     * @param {number} pixelCount
     * @returns
     * @memberof GreenScreenStream
     */
    dominant(imageData: ImageData, pixelCount: number) {
        const p = this.pallette(imageData, pixelCount);
        const d = p[0];
        return d;
    };
    /**
     * Get a pallette (10) of the most used colors in the imageData provided
     *
     * @param {ImageData} imageData
     * @param {number} pixelCount
     * @returns
     * @memberof GreenScreenStream
     */
    pallette(imageData: ImageData, pixelCount: number) {
        const pixelArray = this.pixelArray(imageData.data, pixelCount, 10);
        const cmap = quantize(pixelArray, 8);
        const palette = cmap ? cmap.palette() : null;
        return palette;
    };
}