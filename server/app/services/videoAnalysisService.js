const tcp = require("../modules/tcpModule");
const tf = require("../modules/tfDetector");
const svm = require("../modules/svmDetector");
const detector = require("../modules/motionDetector");
const evtService = require("../services/eventsService");
const recService = require("../services/recordingsService");
const Pipe2Pam = require('pipe2pam');
const cache = require("../modules/cache");
const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jpeg = require('jpeg-js');
const ffmpegModule = require("../modules/ffmpegModule");
const logger = require('../modules/loggingModule').getLogger('videoAnalysisService');
const fs = require("fs");
const GIFEncoder = require('gif-encoder-2');
const { createCanvas } = require('canvas');

let frameIndex = -1;
let frameBuffer = [];

/**
 * Starts video analasys on all configured cameras
 */
async function startVideoAnalysis() {    

  for (const [k, v] of Object.entries(cache.cameras)) {
    if (v.camera.deletedOn == null && v.camera.videoProcessingEnabled){
      await StartVideoProcessing(v.camera);        
    }   
  }
}

/** Creates the feed stream. This stream will be used to parse the Mpeg stream and feeds the chunks to the event emitter **/
async function StartVideoProcessing(cam){

  let streamPort = await tcp.createLocalServer(null, async function(socket){
    cache.services.eventEmmiter.on(`${cam.id}-stream-data`, function (data) {  
      socket.write(data);    
    });
  });

  const args = [
    '-hide_banner',
    '-loglevel',
    'error', 
    '-analyzeduration',
    '0', 
    '-f', 
    'mpegts', 
    '-i', 
    `tcp://127.0.0.1:${streamPort}`, 
    '-an', 
    '-vcodec', 
    'pam', 
    '-pix_fmt', 
    'rgba', 
    '-f', 
    'image2pipe', 
    '-vf', 
    'fps=2,scale=640:360', 
    '-']

  const cpx = ffmpegModule.runFFmpeg(
    args, 
    `[${cam.id}] Video analysis stream`, 
    function(data){
      // on spawn
      logger.log('info', `[${cam.id}] Video analysis stream started on ${streamPort}`);
    },
    null,
    null,
    async function(){
      console.debug(`[${cam.id}] video analysis process closed, restarting...`);
      timeout(14000).then(() => {
        StartVideoProcessing().then(() => {});
      });
    },
    null
  );

  const pipe2pam = new Pipe2Pam();

  pipe2pam.on('pam', async (data) => {
    //console.log('pam');
    await processFrame(cam, data);
  });

  cpx.stdout.pipe(pipe2pam); 
}

//https://video.stackexchange.com/questions/12105/add-an-image-overlay-in-front-of-video-using-ffmpeg
//ffmpeg -i temp.mp4 -i rect-animated.gif -filter_complex "[0:v][1:v] overlay=25:25:enable='between(t,0,20)'" -pix_fmt yuv420p -c:a copy output.mp4
//ffmpeg -i sample.mp4 -i unit_test1.gif -filter_complex "[0:v][1:v] overlay=0:0'" -pix_fmt yuv420p -c:a copy output.mp4

/** Performs motion detection and objecty identification */
async function processFrame(cam, data){
  try{

    _width = parseInt(data.width);
    _height = parseInt(data.height);
    
    //var jpegImageData = jpeg.encode(rawImageData, 50);
    storeFrame(data.pixels);

    //let motion = null;
    let motion = detector.getMotionRegion(frameBuffer);
    // let motion = { 
    //   x: 10, 
    //   y: 20, 
    //   width : 100,
    //   height : 50
    // };
  
    if (motion != null){
      // this is the dimentions from the ffmpeg stream
      //motion.imageWidth = 640;
      //motion.imageHeight = 360;

      let predictions = null;

      if (cam.objectProcessor == "svm"){
        var detection = await svm.processImage(data.pixels, _width, _height); //is data width & height same as image?
        // since SVM does not specify the region, we need to pass the motion region as the dected region
        if (detection && detection.label == 'human'){
          return { 
            detectedOn: new Date(), 
            x: motion.x, 
            y: motion.y, 
            width: motion.width, 
            height: motion.height,
            imageWidth : _width,
            imageHeight : _height
          }
        }
      }

      if (cam.objectProcessor == "tf"){
        var rawImageData = {
          data: data.pixels,
          width: _width,
          height: _height,
        };
        var jpegImageData = jpeg.encode(rawImageData, 50);
        predictions = await tf.processImage(jpegImageData.data, _width, _height);
      }
      
      if (predictions.length > 0){
        cache.services.ioSocket.sockets.emit(`${cam.id}-detect`, predictions);

        // save event + alert
        if (cam.eventConfig.recordEvents){
          recService.recordCamera(cache.cameras[cam.id], cam.eventConfig.recordSeconds ?? 10, function(){
            // save event
            evtService.tryCreateNew({
              cameraId : cam.id,
              occuredOn : new Date() 
            })
          })
        }
      }      
    }

  }
  catch(error){
    logger.log('error', `[${cam.id}] Video processing error : ${error.message}`);
  }  
}

function storeFrame(frame){
  if (frameBuffer.length < 3){
    frameBuffer.push(frame);
    return;
  }

  frameBuffer[0] = frameBuffer[1];
  frameBuffer[1] = frameBuffer[2];
  frameBuffer[2] = frame;
}

/**
 * Generates a gif from the supplied predictions.
 * All gifs are created using the default size 1280x720
 * @param {Array} _predictions - Collection of precitions
 * @param {string} _camId - The camera id
 * @param {number} _clipLength - Total length of event in milliseconds
 * @param {string} _outputFile - Path to save gif to
 */
function createEventGif(_predictions, _camId, _eventDuration, _outputFile){

  var remaining = _clipLength;
  var encoder = new GIFEncoder(1280, 720);
  
  encoder.start();
  encoder.setTransparent(true);
  encoder.setRepeat(0);   
  encoder.setQuality(10); 

  var canvas = createCanvas(1280, 720);
  var ctx = canvas.getContext('2d');

  for (let i = 0; i < _predictions.length; i++) {

      ctx.strokeStyle = _predictions[i].c;  
      var diff = i == _predictions.length - 1
          ? remaining
          : _predictions[i + 1].startTime - _predictions[i].startTime;

      remaining -= diff;
      
      encoder.setDelay(diff); 
      ctx.strokeRect(_predictions[i].x, _predictions[i].y, _predictions[i].width, _predictions[i].height);                
      encoder.addFrame(ctx);

      encoder.setDelay(0);  
      ctx.clearRect(0, 0, 1280, 720);
      encoder.addFrame(ctx);
  }

  encoder.finish();

  const buffer = encoder.out.getData();
  fs.writeFileSync(_outputFile, buffer);
  console.log('done');
}

/*
  const mapRange = (value : number, inMin : number, inMax: number, outMin: number, outMax: number) => {
    value = (value - inMin) / (inMax - inMin);
    return outMin + value * (outMax - outMin);
  };
*/

module.exports.createEventGif = createEventGif;
module.exports.startVideoAnalysis = startVideoAnalysis;