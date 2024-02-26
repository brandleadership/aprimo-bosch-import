/**
 * 
 * Main file to read CSV and provide row data to workers.
 * 
 */
require('winston-daily-rotate-file');
var path = require("path");
var fs = require("fs");
let Client = require("ssh2-sftp-client");
const Piscina = require('piscina')
const csv = require("csvtojson");
const XLSX = require('xlsx');
const ftpConfig = JSON.parse(fs.readFileSync("ftp.json"));
const winston = require("winston");
const arrayApp = require('lodash');
const axios = require("axios").default;
const HttpsProxyAgent = require('https-proxy-agent');
const { JsonDB, Config } = require('node-json-db');
const dbtoken = new JsonDB(new Config("apitoken", false, true, '/'));
const templateAsset = new JsonDB(new Config("template", false, true, '/'));
const langAsset = new JsonDB(new Config("languages", false, true, '/'));
const kMap = new JsonDB(new Config("keymapping", false, true, '/'));
const langMap = new JsonDB(new Config("languagemapping", false, true, '/'));
const oTypes = new JsonDB(new Config("otypes-mapping", false, true, '/'));
const cron = require('node-cron');
const os = require('os');
const cpus = os.cpus();
const axiosRetry = require('axios-retry');
axiosRetry(axios, { retries: 3 });

// Default JobID to protect any processing error
let pJobID = 'job_000000';
const {
  v4: uuidv4
} = require('uuid');
// Read default configuration
const APR_CREDENTIALS = JSON.parse(fs.readFileSync("aprimo-credentials.json"));
var fullProxyURL=APR_CREDENTIALS.proxyServerInfo.protocol+"://"+ APR_CREDENTIALS.proxyServerInfo.host +':'+APR_CREDENTIALS.proxyServerInfo.port;
if(APR_CREDENTIALS.proxyServerInfo.auth.username!="")
{
  fullProxyURL=APR_CREDENTIALS.proxyServerInfo.protocol+"://"+APR_CREDENTIALS.proxyServerInfo.auth.username +":"+ APR_CREDENTIALS.proxyServerInfo.auth.password+"@"+APR_CREDENTIALS.proxyServerInfo.host +':'+APR_CREDENTIALS.proxyServerInfo.port;
}

// Create a new thread pool
const pool = new Piscina(
  {
    minThreads: APR_CREDENTIALS.worker, 
    maxQueue: 'auto'
  })
const options = {
  filename: 'aprimo-bosch-import.js'
}


/**
 * Log File
 */
var appError = new winston.transports.DailyRotateFile({
  level: 'error',
  name: 'error',
  filename: './logs/bosch-app-error.log',
  createSymlink: true,
  symlinkName: 'bosch-app-error',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});
var appCombined = new winston.transports.DailyRotateFile({
  name: 'info',
  filename: './logs/bosch-app-combined.log',
  createSymlink: true,
  symlinkName: 'bosch-app-combined.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});

const logger = winston.createLogger({
  level: 'info',
  transports: [appError, appCombined]
});


logger.info(new Date() + '####### Operating system: ' + process.platform );
logger.info(new Date() + '####### Architecture: ' + process.arch );
logger.info(new Date() + '####### Node.js version: ' + process.version );
logger.info(new Date() + '####### Number of CPUs: ' + os.cpus().length );
logger.info(new Date() + '####### Number of threads: ' + (process.env.UV_THREADPOOL_SIZE || os.cpus().length)  );
cpus.forEach((cpu, i) => {
  logger.info(new Date() + '####### CPU :' + (i + 1) );
  logger.info(new Date() + '####### Model: ' + cpu.model );
  logger.info(new Date() + '####### Speed: ' + cpu.speed + ' MHz' );
  logger.info(new Date() + '####### Times: #########');
  logger.info(new Date() + '#######    User: ' + cpu.times.user + ' ms  #########');
  logger.info(new Date() + '#######    Nice: ' + cpu.times.nice + ' ms  #########');
  logger.info(new Date() + '#######    Sys: ' + cpu.times.sys + ' ms  #########');
  logger.info(new Date() + '#######    Idle: ' + cpu.times.idle + ' ms  #########');
  logger.info(new Date() + '#######    IRQ: ' + cpu.times.irq + '  ms #########');
});

const totalMem = os.totalmem();
const freeMem = os.freemem();
logger.info(new Date() + '####### Total memory: ' + Math.round(totalMem / 1024 / 1024) + 'MB');
logger.info(new Date() + '####### Free memory: ' + Math.round(freeMem / 1024 / 1024) + 'MB');
logger.info(new Date() + '####### Worker Set: ' + APR_CREDENTIALS.worker);

/**
 * 
 * Create a checkin excel file from the CSV data
 * @param {*} jobID
 */
async function JSONtoCheckInData(jobID) {
  try{
    if (fs.existsSync(APR_CREDENTIALS.checkin)) {
      // Return back if already running
      return true;
    }else{    
      // Get All CSV files from FTP Target Path
      const csvInDir = fs
        .readdirSync(APR_CREDENTIALS.targetPath)
        .filter((file) => path.extname(file) === ".csv");

      let csvFileData = [];
      for (var i = 0, len = csvInDir.length; i < len; i++) {
        let file = csvInDir[i];
        if (file) {
          if (file === jobID + APR_CREDENTIALS.MasterDataDelta){
            const deltaFilePath = APR_CREDENTIALS.targetPath + "/" + jobID + APR_CREDENTIALS.MasterDataDelta;
            // Read CSV files
            const deltaMasterData = await csv({
              'delimiter': [';', ','],
              'quote': '"',
              preserveLineEndings: true
            }).fromFile(deltaFilePath);
            await writeExcel(deltaMasterData, jobID, APR_CREDENTIALS.targetPath + "/" + 'deltaMasterData.xlsx');
          } else { 
            const filePath = APR_CREDENTIALS.targetPath + "/" + file;
            // Read CSV files
            const csvFileDataTmp = await csv({
              'delimiter': [';', ','],
              'quote': '"',
              preserveLineEndings: true
            }).fromFile(filePath);
            // Merge Into One Array Object
            csvFileData = arrayApp.concat(csvFileData, csvFileDataTmp);
          }
        }
      }
      
      // Write Excel File
      await writeExcel(csvFileData, jobID, APR_CREDENTIALS.checkin);
      return true;
    }
  } catch (e) {
    logger.info(new Date() + ': ERROR: Write Excel File: ' + e.message);
    return false;
  }
};

/**
 * Download CSV files from the FTP
 */
downloadCSVFromFtp = async () => {
  let tempDirectory = APR_CREDENTIALS.targetPath;
  // Read CSV files from temp directories
  fs.readdir(tempDirectory, (err, files) => {
    if (err) {
      logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING READ DIRECTORY');
    }

    for (const file of files) {
      if (file.match(/.+(\.csv)$/)) {
        // Delete CSV files from temp directory
        fs.unlink(path.join(tempDirectory, file), (err) => {
          if (err){
            logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING DELETE FILE');
          }
        });
      }
    }
  });
  // Read binary files from local path 
  fs.readdir(APR_CREDENTIALS.imgFolderPath, (err, files) => {
    if (err){
      logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING PATH MISSING');
    }

    for (const file of files) {
      // Delete all downloaded files
      fs.unlink(path.join(APR_CREDENTIALS.imgFolderPath, file), (err) => {
        if (err){
          logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING DELETE FILE');
        }
      });
    }
  });

  var jsonData;
  const dst = APR_CREDENTIALS.targetPath;
  const src = APR_CREDENTIALS.sourcePath;
  let sftp = new Client();
  // Connect SFTP
  jsonData = await sftp.connect(ftpConfig)
    .then(async () => {
      const files = await sftp.list(src + '/.');
      // Sort files by name
      files.sort((a,b) => a.name.localeCompare(b.name));
      // Process listed files
      sftp.end();
      for (var i = 0, len = files.length; i < len; i++) {
        // Check for .finished file
        if (files[i].name.match(/.+(\.finished)$/)) {
          let jobID = path.parse(files[i].name).name;
          let importFinished = false;
          importFinished = arrayApp.find(files, function(obj) {
            if (obj.name === jobID + '.importFinished') {
                return true;
            }
          });
          if(!importFinished){
            logger.info('####### Import Started for ' + jobID + ' at ' + new Date() + ' #########');
            // Create .finished file for reference 
            fs.openSync(dst + '/' + jobID + '.finished', 'w');
            let sftpSub = new Client();
            await sftpSub.connect(ftpConfig).then(async () => {
              const csvfiles = await sftpSub.list(src + '/' + jobID + '/.');
              for (var j = 0, csvlen = csvfiles.length; j < csvlen; j++) {
                if (csvfiles[j].name.match(/.+(\.csv)$/) || csvfiles[j].name.match(/.+(\.xlsx)$/)) {
                  await sftpSub.fastGet(src + '/' + jobID + '/' + csvfiles[j].name, dst + '/' + csvfiles[j].name);
                }
              }  
            }).catch(e => {
              logger.info(new Date() + ': ERROR: In FTP Connection: ' + e.message);
            });
            sftpSub.end();

            // Create a reference point for each process.
            let JSONprocess = await JSONtoCheckInData(jobID);
            let DEprocess = await readDeltaMasterExcel();
            /*

            let REprocess = await readExcel(0);
            let CRprocess = await createRelation();
            let CLRPprocess = await createLanguageRelationParent();
            let CLRCprocess = await createLanguageRelationChild();
            
            if(JSONprocess && REprocess && CRprocess && CLRPprocess && CLRCprocess){
              // End process with success reference
              await endProcess(jobID, true);
              logger.info('####### Import Ended for ' + jobID + ' at ' + new Date() + ' #########');
            }else{
              // End process with fail reference
              await endProcess(jobID, false);
              if(!JSONprocess){
                logger.info('####### Import Ended with ERROR in JSON Process for ' + jobID + ' at ' + new Date() + ' #########');
              }else if(!REprocess){
                logger.info('####### Import Ended with ERROR in Read Excel Process for ' + jobID + ' at ' + new Date() + ' #########');
              }else if(!CRprocess){
                logger.info('####### Import Ended with ERROR in Create Relation Process for ' + jobID + ' at ' + new Date() + ' #########');
              }else if(!CLRPprocess){
                logger.info('####### Import Ended with ERROR in Create Language Relation Parent Process for ' + jobID + ' at ' + new Date() + ' #########');
              }else if(!CLRCprocess){
                logger.info('####### Import Ended with ERROR in Create Language Relation Child Process for ' + jobID + ' at ' + new Date() + ' #########');
              }
            }   
            
            */
          }
        }
      }
    }).catch(e => {
      logger.info(new Date() + ': ERROR: In FTP Connection: ' + e.message);
    });
  
  return jsonData;
};

/**
 * 
 * readExcel to process csv data. 
 * @param {*} reTryIndex
 */
async function readExcel(reTryIndex) {
  try {
    logger.info('####### '+ ' ' + process.pid + ': Read Excel Started at ' + new Date() + ' #########');
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    const sheets = file.SheetNames;
    //Read excel sheets
    for (let i = 0; i < sheets.length; i++) {
      const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]], {
        defval: ""
      });
      let index = 0;
      let cpuIndex = 0;
      let poolArray = [];
      for (const row of csvData) {
        // Check checkin file.
        row.index = index;
        pJobID = row.JOB_ID;

        if (row?.appstatus !== 'checkin') {
          cpuIndex++;
          row.appstatus = 'checkin';
          // Create pool for record
          poolArray.push(pool.run({
            rowdata: row,
            mode: 'createRecords' // Select mode of processing to createRecords
          }, options));
          // Check for worker setting
          if (cpuIndex === APR_CREDENTIALS.worker) {
            const result = await Promise.all(poolArray)
            cpuIndex = 0;
            poolArray = [];
            for (let r = 0; r < result.length; r++) {
              // Set meta information for job excelsheet
              csvData[result[r].rowdata.index].recordID = result[r].recordID;
              csvData[result[r].rowdata.index].startTime = result[r].startTime;
              csvData[result[r].rowdata.index].endTime = result[r].endTime;
              csvData[result[r].rowdata.index].message = result[r].message;
              if(result[r].recordID === 0){
                csvData[result[r].rowdata.index].appstatus = 'error';
              }
            }
          }
        }
        if (index % (APR_CREDENTIALS.worker * 10) === 0) {
          logger.info('####### '+ ' ' + process.pid + ': Write Excel at ' + new Date() + ' #########');
          await writeExcel(csvData, 'null', APR_CREDENTIALS.checkin);
        }
        index++;
      }

      //Process last remaining bunch of rows
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray)
        for (let r = 0; r < result.length; r++) {
          csvData[result[r].rowdata.index].recordID = result[r].recordID;
          csvData[result[r].rowdata.index].startTime = result[r].startTime;
          csvData[result[r].rowdata.index].endTime = result[r].endTime;
          csvData[result[r].rowdata.index].message = result[r].message;
          if(result[r].recordID === 0){
            csvData[result[r].rowdata.index].appstatus = 'error';
          }
        }
        poolArray = [];
        logger.info('####### '+ ' ' + process.pid + ': Write Excel at ' + new Date() + ' #########');
        await writeExcel(csvData, 'null', APR_CREDENTIALS.checkin);
      }else{
        logger.info('####### '+ ' ' + process.pid + ': Write Excel at ' + new Date() + ' #########');
        await writeExcel(csvData, 'null', APR_CREDENTIALS.checkin);
      }

      const appStatus = csvData.filter((row) => row['appstatus'] === 'error');
      // Retry for ERROR Rows 
      if(appStatus.length > 0 && reTryIndex < 3) {
        reTryIndex++;
        logger.info(new Date() + ' : JobID: ' + pJobID + ' Start Retry ' + reTryIndex);
        // Retry Delay 2 Sec
        setTimeout(async function() {
          await readExcel(reTryIndex);
        }, 2000);
        logger.info(new Date() + ' : JobID: ' + pJobID + ' End Retry ' + reTryIndex);
      }
    }

    logger.info('####### '+ ' ' + process.pid + ': Read Excel Ended at ' + new Date() + ' #########');
    return true;
  } catch (e) {
    logger.info(new Date() + ': ERROR: Read Excel File: ' + e.message);
    return false;
  }
}


/**
 * 
 * readDeltaMasterExcel to process csv data. 
 * @param {*} reTryIndex
 */
async function readDeltaMasterExcel() {
  let tempAssetObj = await templateAsset.getData("/asset");
  try {
    logger.info('####### '+ ' ' + process.pid + ': Read Delta Master Excel Started at ' + new Date() + ' #########');
    const file = XLSX.readFile(APR_CREDENTIALS.targetPath + "/" + 'deltaMasterData.xlsx');
    const sheets = file.SheetNames;
    //Read excel sheets
    for (let i = 0; i < sheets.length; i++) {
      const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]], {
        defval: ""
      });
      let index = 0;
      for (const row of csvData) {
        // Check checkin file.
        csvData[index].index = index;
        if (row?.appstatus !== 'updated' && row?.appstatus !== 'error' && row?.appstatus !== 'checkin' && row?.appstatus !== 'skip') {
          let mapdata = await kMap.getData("/mpefiledmapping/" + row['KEY']);
          if(mapdata.type === 'Option List'){
            let fieldID = findObject(tempAssetObj, 'fieldName', mapdata.map);
            if (fieldID.hasOwnProperty('0')) {
              let optionAPI = await addOrUpdateOptionList(fieldID[0].id, row['KEY'], row['LABEL']);
              if(optionAPI === true){
                csvData[index].appstatus = 'updated';
                csvData[index].message = '';
              } else {
                csvData[index].appstatus = 'error';
                csvData[index].message = optionAPI;
              }
            } else {
              logger.info(new Date() +  ': DATA WARNING Field Key not in the Mapping Table. KEY: ' + row['KEY'] + ' ID: ' + row['ID'] + ' LABEL: ' + row['LABEL']);
            }
          } else if (mapdata.type === 'Classification'){
            let classificationAPI = await addOrUpdateClassification(row, mapdata.parentpath);
            if(classificationAPI === true){
              csvData[index].appstatus = 'updated';
              csvData[index].message = '';
            } else {
              csvData[index].appstatus = 'error';
              csvData[index].message = classificationAPI;
            }
          } else {
            csvData[index].appstatus = 'skip';
            csvData[index].message = 'No need to update';
          }
          // Write in the Excel
          await writeExcel(csvData, 'null', APR_CREDENTIALS.targetPath + "/" + 'deltaMasterData.xlsx');
        }
        index++;
      }
    }
    logger.info('####### '+ ' ' + process.pid + ': Read Delta Master Excel Ended at ' + new Date() + ' #########');
    return true;
  } catch (e) {
    logger.info(new Date() + ': ERROR: Read Excel File: ' + e.message);
    return false;
  }
}

async function getLastString(breakString) {
  if (typeof breakString === 'string'){
    let str_array = breakString.split('\\\\');
    for (let splitIndex = 0; splitIndex < str_array.length; splitIndex++) {
      // Trim the excess whitespace.
      let treeIDs = str_array[splitIndex];
      let pieces = treeIDs.split("||");
      let lastValue = pieces[pieces.length - 1];
      lastValue = lastValue.replace(/^\s*/, "").replace(/\s*$/, "");
      if(lastValue !== null){
        return lastValue;
      }else{
        return false;
      }
    }
  }
}

/**
 * 
 * addOrUpdateClassification for new classification.
 * @param {*} row, classParentPath
 */
addOrUpdateClassification = async (row, classParentPath) => {
  let classDataID = row['ID'];
  let classDataLabel = row['LABEL'];
  if(classDataLabel.includes("||")){    
    let getLastStringID = await getLastString(classDataID);    
    if(getLastStringID !== false){
      classDataID = getLastStringID;
    }else{
      logger.info(new Date() +  ': DATA WARNING Last String ID Not Found: ' + classDataID);
      return false;  
    }
    let getLastStringValue = await getLastString(classDataLabel);

    if(getLastStringValue !== false){
      const splitString = classDataLabel.replace(/\//g, "\\/").replace(/\|\|/g, "/");
      const parentPath = splitString.substring(0, splitString.lastIndexOf("/"));
      classParentPath = classParentPath + parentPath;
      classDataLabel = getLastStringValue;
    }else{
      logger.info(new Date() +  ': DATA WARNING Last String Value Not Found: ' + classDataLabel);
      return false;  
    }
  }

  let classLanguageAsset = await langAsset.getData("/asset");
  let classLanguageID = findObject(classLanguageAsset, 'culture', 'en-GB');
  if (!classLanguageID.hasOwnProperty('0')) {
    logger.info(new Date() +  ': DATA WARNING en-GB ID not found.');
    return false;
  }

  let updateObj = {
    "parentNamePath": classParentPath,
    "name": classDataLabel,
    "identifier": classDataID,
    "labels": [
        {
            "languageId": classLanguageID[0].id,
            "value": classDataLabel
        }
    ]
  };

  // Log the update object
  logger.info(new Date() +  ' INFO : addOrUpdateClassification JSON:' + JSON.stringify(updateObj));
  // Get Token For API
  let token = await dbtoken.getObjectDefault("/token", "null");

  let reqUpdateRequest = await axios.post(APR_CREDENTIALS.CreateClass,
      JSON.stringify(updateObj), {
        proxy: false,
        httpsAgent: new HttpsProxyAgent(fullProxyURL),  
        headers: {
            Accept: "*/*",
            "Content-Type": "application/json",
            "API-VERSION": APR_CREDENTIALS.Api_version,
            'select-fileversion': 'Metadata, renditions, Content', 
            'disable-validations': 'true', 
            'disable-rules': 'true', 
            'client-id': 'marketing-ops',
            Authorization: `Bearer ${token}`,
          },
      }
    )
    .then((res) => {
      logger.info(new Date() +  ' INFO : addOrUpdateClassification done.');
      return true;
    })
    .catch((err) => {
      logger.error(new Date() +  ' ERROR : addOrUpdateClassification API -- classParentPath: ' + classParentPath + " classDataLabel: " + classDataLabel + " classDataID: " + classDataID);
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() +  ' ERROR : addOrUpdateClassification API -- ' + JSON.stringify(err.response.data));
        return JSON.stringify(err.response.data);
      } else {
        logger.error(new Date() +  ' ERROR : addOrUpdateClassification API -- ' + JSON.stringify(err));
        return JSON.stringify(err);
      }        
    });
  return reqUpdateRequest;
};

/**
 * 
 * addOrUpdateOptionList for new meta.
 * @param {*} fieldID, optionName, optionLabel
 */
addOrUpdateOptionList = async (fieldID, optionName, optionLabel) => {
  let optionLanguageAsset = await langAsset.getData("/asset");
  let optionLanguageID = findObject(optionLanguageAsset, 'culture', 'en-GB');
  if (!optionLanguageID.hasOwnProperty('0')) {
    logger.info(new Date() +  ': DATA WARNING en-GB ID not found.');
    return false;
  }

  let updateObj = {
    "items": {
      "addOrUpdate": [
        {
          "name": optionLabel, 
          "label": optionLabel,
          "labels": [
            {
              "languageId": optionLanguageID[0].id,
              "value": optionLabel
            }
          ],
          "tag": "<xml>Created by API Script</xml>"
        }
      ]
    }
  }

  // Log the update object
  logger.info(new Date() +  ' INFO : addOrUpdateOptionList KEY: ' + optionName + ' JSON: ' + JSON.stringify(updateObj));
  
  // Get Token For API
  let token = await dbtoken.getObjectDefault("/token", "null");

  // Update Option List
  let reqUpdateRequest = await axios
    .put(APR_CREDENTIALS.addOrUpdateOption + fieldID, JSON.stringify(updateObj), {
      proxy: false,
      httpsAgent: new HttpsProxyAgent(fullProxyURL),  
      headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "API-VERSION": APR_CREDENTIALS.Api_version,
          'select-fileversion': 'Metadata, renditions, Content', 
          'disable-validations': 'true', 
          'disable-rules': 'true', 
          'client-id': 'marketing-ops',
          Authorization: `Bearer ${token}`,
        },
    })
    .then(async (resp) => {
      logger.info(new Date() +  ' INFO : Option addOrUpdated done.');
      return true;
    })
    .catch((err) => {
      logger.error(new Date() +  ' ERROR : addOrUpdateOptionList API -- optionID: ' + fieldID + " optionName: " + optionName + " optionLabel: " + optionLabel);
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() +  ' ERROR : addOrUpdateOptionList API -- ' + JSON.stringify(err.response.data));
        return JSON.stringify(err.response.data);
      } else {
        logger.error(new Date() +  ' ERROR : addOrUpdateOptionList API -- ' + JSON.stringify(err));
        return JSON.stringify(err);
      }        
    });
  return reqUpdateRequest;
};


/**
 * 
 * createRelation for master records. 
 */
async function createRelation() {
  try {
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    const sheets = file.SheetNames;
    for (let i = 0; i < sheets.length; i++) {
      const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]], {
        defval: ""
      });
      // Filter master records with record ID not equal to blank and not equal to zero
      const masterData = csvData.filter((row) => row['MASTER_RECORD'] === 'x' && row['recordID'] != '' && row['recordID'] != 0);
      let index = 0;
      let cpuIndex = 0;
      let poolArray = [];

      for (const masterDataRow of masterData) {        
        if (masterDataRow?.appstatus === 'checkin') {
          cpuIndex++;          
          const childData = csvData.filter((row) => row['OBJ_ID'] === masterDataRow.OBJ_ID && row['recordID'] != '' && row['recordID'] != 0 && row['MASTER_RECORD'] != 'x');
          let childRecordID = [];
          for (const childDataRow of childData) {
            childRecordID.push(childDataRow.recordID);
          }

          if (childRecordID.length > 0) {
            poolArray.push(pool.run({
              rowdata: {
                masterRecordID: masterDataRow.recordID,
                masterData: masterDataRow,
                childRecordID: childRecordID
              },
              mode: 'linkRecords' // Select mode of processing to linkRecords
            }, options));
          }
          if (cpuIndex === APR_CREDENTIALS.worker) {
            const result = await Promise.all(poolArray);
            cpuIndex = 0;
            poolArray = [];
          }
        }
        index++;
      }
      // Process remaining records
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        poolArray = [];
        await writeExcel(csvData, 'null', APR_CREDENTIALS.checkin);
      }else{
        await writeExcel(csvData, 'null', APR_CREDENTIALS.checkin);
      }
    }
    return true;
  } catch (e) {
    logger.info(new Date() + ': ERROR: createRelation: ' + e.message);
    return false;
  }
}

/**
 * 
 * createLanguageRelationParent for master records. 
 */
async function createLanguageRelationParent() {
  try {
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    const sheets = file.SheetNames;
    for (let i = 0; i < sheets.length; i++) {
      const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]], {
        defval: ""
      });
      // Filter records with RELATED_DOCUMENT and recordID not equal to zero
      const masterData = csvData.filter((row) => row['RELATED_DOCUMENT'] != '' && row['recordID'] != 0);
      let cpuIndex = 0;
      let poolArray = [];

      for (const masterDataRow of masterData) {
        cpuIndex++;
        const childData = csvData.filter((row) => row['OBJ_ID'] === masterDataRow.RELATED_DOCUMENT && row['recordID'] != '' && row['recordID'] != 0);
        let childRecordID = [];
        for (const childDataRow of childData) {
          childRecordID.push(childDataRow.recordID);
        }

        if (childRecordID.length > 0) {
          poolArray.push(pool.run({
            rowdata: {
              masterRecordID: masterDataRow.recordID,
              masterData: masterDataRow,
              childRecordID: childRecordID
            },
            mode: 'LanguageRelationParent' // Select mode of processing to LanguageRelationParent
          }, options));
        }
        if (cpuIndex === APR_CREDENTIALS.worker) {
          const result = await Promise.all(poolArray);
          cpuIndex = 0;
          poolArray = [];
        }
      }

      // Process remaining records
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        poolArray = [];
      }
    }
    return true;
  } catch (e) {
    logger.info(new Date() + ': ERROR: createLanguageRelationParent: ' + e.message);
    return false;
  }
}

/**
 * 
 * createLanguageRelationChild for master records. 
 */
async function createLanguageRelationChild() {
  try {
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    const sheets = file.SheetNames;
    for (let i = 0; i < sheets.length; i++) {
      const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]], {
        defval: ""
      });
      const masterData = csvData.filter((row) => row['RELATED_DOCUMENT[USAGE]'] != '' && row['recordID'] != 0);
      let cpuIndex = 0;
      let poolArray = [];

      for (const masterDataRow of masterData) {
        cpuIndex++;
        if (typeof masterDataRow['RELATED_DOCUMENT[USAGE]'] === 'string') {
          var str_array = masterDataRow['RELATED_DOCUMENT[USAGE]'].split(',');
          let childRecordID = [];
          for (var str = 0; str < str_array.length; str++) {
            // Trim the excess whitespace.
            str_array[str] = str_array[str].replace(/^\s*/, "").replace(/\s*$/, "");
            const childData = csvData.filter((row) => row['OBJ_ID'] === str_array[str] && row['recordID'] != '' && row['recordID'] != 0);
            for (const childDataRow of childData) {
              childRecordID.push(childDataRow.recordID);
            }
          }

          if (childRecordID.length > 0) {
            poolArray.push(pool.run({
              rowdata: {
                masterRecordID: masterDataRow.recordID,
                masterData: masterDataRow,
                childRecordID: childRecordID
              },
              mode: 'LanguageRelationChild' // Select mode of processing to LanguageRelationChild
            }, options));
          }
          if (cpuIndex === APR_CREDENTIALS.worker) {
            const result = await Promise.all(poolArray);
            cpuIndex = 0;
            poolArray = [];
          }
        }
      }
      // Process remaining records
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        poolArray = [];
      }
    }
    return true;
  } catch (e) {
    logger.info(new Date() + ': ERROR: createLanguageRelationChild: ' + e.message);
    return false;
  }
}

/**
 * 
 * endProcess
 */  
async function endProcess(jobID, pStatus) {
  try {
    let statusLabel = 'error';
    let src = APR_CREDENTIALS.targetPath;
    let dst = APR_CREDENTIALS.sourcePath;
    // Create .importFinished file
    fs.openSync(src + '/' + jobID  + '.importFinished', 'w');

    if(pStatus){
      const csvfile = XLSX.readFile(APR_CREDENTIALS.checkin);
      const sheets = csvfile.SheetNames;
      let sftpEP = new Client();
      for (let i = 0; i < sheets.length; i++) {
        const csvData = XLSX.utils.sheet_to_json(csvfile.Sheets[csvfile.SheetNames[i]], {
          defval: ""
        });

        const appStatus = csvData.filter((row) => row['appstatus'] === 'error');
        if(appStatus.length > 0){
          // Create .error file
          fs.openSync(src + '/' + jobID  + '.error', 'w');
        }else{
          // Create .completed file
          fs.openSync(src + '/' + jobID  + '.completed', 'w');
        }

        await sftpEP.connect(ftpConfig).then(async () => {
          await sftpEP.put(APR_CREDENTIALS.checkin, dst + '/' + jobID  + '/checkindata.xlsx');
          await sftpEP.put(src + '/' + jobID  + '.importFinished', dst + '/' + jobID  + '.importFinished');
          if(appStatus.length > 0){
            statusLabel = 'error';
            await sftpEP.put(src + '/' + jobID  + '.error', dst + '/' + jobID  + '.error');
          }else{
            statusLabel = 'completed';
            await sftpEP.put(src + '/' + jobID  + '.completed', dst + '/' + jobID  + '.completed');
          }
        }).catch(async (e) => {
            logger.info(new Date() + ': ERROR: Updating File Name in FTP Server ' + e);
        }); 
      }
      sftpEP.end();
    }else{
      let sftpEP = new Client();
      await sftpEP.connect(ftpConfig).then(async () => {
        await sftpEP.put(APR_CREDENTIALS.checkin, dst + '/' + jobID  + '/checkindata.xlsx');
        await sftpEP.put(src + '/' + jobID  + '.importFinished', dst + '/' + jobID  + '.importFinished');
        statusLabel = 'error';
        await sftpEP.put(src + '/' + jobID  + '.error', dst + '/' + jobID  + '.error');
      }).catch(async (e) => {
          logger.info(new Date() + ': ERROR: Updating File Name in FTP Server ' + e);
      });
      sftpEP.end();
    }
    // Create file name with date and time
    const fileNameDatetime = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-").replace("T", "_").replace("Z", "");
    let fileName = APR_CREDENTIALS.targetPath + '/' + jobID + '_' + fileNameDatetime + '_' + statusLabel + '.xlsx';
    await fs.rename(APR_CREDENTIALS.checkin, fileName, function (err) {
      if (err){
        logger.error(new Date() + ' JobID: ' + jobID + ' : ERROR IN RENAME');
      }
    });

    let tempDirectory = APR_CREDENTIALS.targetPath;
    fs.readdirSync(tempDirectory).forEach(file => {
      if (file.match(/.+(\.csv)$/)) {
        // Delete CSV files from temp directory
        fs.unlink(path.join(tempDirectory, file), (err) => {
          if (err){
            logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING DELETE FILE');
          }
        });
      }
    });
  } catch (e) {
    logger.info(new Date() + ': ERROR: endProcess: ' + e.message);
  }
}

/**
 * 
 * writeExcel file from the JSON object
 */  
async function writeExcel(jsonArray, jobID, writeFileName) {
  try {
    if(jobID !== 'null' && jsonArray.hasOwnProperty('0')){
      jsonArray[0].JOB_ID = '';
    }
    // Array for column head
    let arrayKeys = [];
    jsonArray.forEach((row) => {
      // Extract column head from row data
      arrayKeys = arrayApp.concat(arrayKeys, arrayApp.keys(row));
    });
    let keys = arrayApp.uniq(arrayKeys); 

    // Create a new workbook and worksheet
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet([], {
      header: keys
    });

    jsonArray.forEach((row) => {
      let objData = {};
      keys.forEach((keyval) => {
        if(keyval==='JOB_ID' && jobID !== 'null'){
          objData[keyval] = jobID;
        }else{
          objData[keyval] = row[keyval];
        }        
      });

      XLSX.utils.sheet_add_json(worksheet, [objData], {
        skipHeader: true,
        origin: -1
      });
    });

    // Add the worksheet to the workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
    // Write the workbook to a file
    XLSX.writeFile(workbook, writeFileName);

  } catch (e) {
    logger.info(new Date() + ': ERROR: writeExcel: ' + e.message);
  }
}

/**
 * Search for Asset 
 * @param {*} token, queryString, strLabel
 */
searchAsset = async (token, queryString, strLabel) => {
  // Search asset API call
  logger.info(new Date() + ': Search Asset ' + strLabel);
  let APIResult = await axios
    .get(APR_CREDENTIALS.SearchAsset + encodeURI(queryString), 
    { 
      proxy: false,
      httpsAgent: new HttpsProxyAgent(fullProxyURL), 
      headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "API-VERSION": APR_CREDENTIALS.Api_version,
          Authorization: `Bearer ${token}`,
        },
    })
    .then(async (resp) => {
      const itemsObj = resp.data;
      let getFieldsResult = 0;
      if (itemsObj.totalCount === 0) {
        logger.info(new Date() + ': INFO: Search Asset '+strLabel+' Not Found ');
      } else if (itemsObj.totalCount === 1) {
          logger.info(new Date() + ': Search Asset ID:'+ itemsObj.items[0].id );
          getFieldsResult = itemsObj.items[0].id;
      }else{
        logger.info(new Date() + ': INFO: Search Asset '+strLabel+' Not Found ');
      }
      return getFieldsResult;
    })
    .catch(async (err) => {
      logger.error(new Date() + ': ERROR: Search Asset API '+strLabel+' Not Found ');
      return 0;
    });
  return APIResult;
};

/**
 * 
 * Find fields IDs for updating records. 
 * @param {*} token
 */
checkTempAsset = async () => {
  await dbtoken.reload();
  let token = await dbtoken.getObjectDefault("/token", "null");
  // Search template asset
  let tempAssetID = await searchAsset(token, "'999999999'" + " and FieldName('mpe_job_id') = 'job_999999999'", 'Template Asset');
  
  if(tempAssetID !== 0){
  let getFieldsResult = await axios
    .get(APR_CREDENTIALS.GetRecord_URL + tempAssetID + '/fields', {
      proxy: false,
      httpsAgent: new HttpsProxyAgent(fullProxyURL), 
      headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "API-VERSION": APR_CREDENTIALS.Api_version,
          Authorization: `Bearer ${token}`,
        },
      })
    .then(async (resp) => {
      if (resp.data.items.length > 0) {
        // Write result json in local templateAsset DB
        await templateAsset.push("/asset", resp.data.items);
        await templateAsset.save();
        return true;
      } else {
        // Write log if template asset missing in the Aprimo
        logger.error(new Date() + ': ERROR : tempAssetID Missing --');
        return false;
      }
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err));
      }
      return false;
    });
      return getFieldsResult;
    }else{
      return false;
    }  
};

/**
 * 
 * Find Language IDs for updating records. 
 * @param {*} token
 */
checkLangAsset = async () => {
  // Check language API
  await dbtoken.reload();
  let token = await dbtoken.getObjectDefault("/token", "null");
  let getAPIResult = await axios
    .get(APR_CREDENTIALS.BaseURL + 'core/languages/?pageSize=400', {
      proxy: false,
      httpsAgent: new HttpsProxyAgent(fullProxyURL), 
      headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "API-VERSION": APR_CREDENTIALS.Api_version,
          Authorization: `Bearer ${token}`,
        },
      })
    .then(async (resp) => {
      if (resp.data.items.length > 0) {
        // Write result json in local langAsset DB
        await langAsset.push("/asset", resp.data.items);
        await langAsset.save();
        return true;
      } else {
        // Write log if language missing
        logger.error(new Date() + ': ERROR : checkLangAsset Missing --');
        return false;
      }
    })
    .catch(async (err) => {
      // Write log for API error
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': ERROR : checkLangAsset API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : checkLangAsset API -- ' + JSON.stringify(err));
      }
      return false;
    });
    return getAPIResult;
};
/**
 * Generating a token and write in the local DB
 */
getToken = async () => {
  let resultAssets = await axios.post(APR_CREDENTIALS.API_URL, JSON.stringify('{}'),{
        proxy: false,
        httpsAgent: new HttpsProxyAgent(fullProxyURL),
        headers: {
        "Content-Type": "application/json",
        "client-id": APR_CREDENTIALS.client_id,
        Authorization: `Basic ${APR_CREDENTIALS.Auth_Token}`,
        },
      }
    ).then(async (resp) => {
      logger.info(new Date() + ': API Token Generated: ###################################');
      return resp.data;
    })
    .catch(async (err) => {    
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': getToken error -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': getToken error -- ' + JSON.stringify(err));
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
      let aprToken = await getToken();
      return aprToken;
    });  

    if(resultAssets?.accessToken !== undefined){
      // Write result token in local DB
      await dbtoken.push("/token", resultAssets.accessToken);
      await dbtoken.save();
      return resultAssets;
    }else{
      return 'null';
    }
};

/**
 * Internal cron setting for generating a tokens and update in the local DB
 */
let task = cron.schedule("*/5 * * * *", async () => {
  await getToken();
  
  if (fs.existsSync(APR_CREDENTIALS.checkin)) {
    if(isFileOlderThanHours(APR_CREDENTIALS.checkin)){
      // Delete checkindata file to restart process.
      fs.unlink(APR_CREDENTIALS.checkin, (err) => {
        if (err){
          logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING IN DELETE FILE: ' + APR_CREDENTIALS.checkin);
        }
      });

      logger.info(new Date() + ': ' + process.pid + ': Restart Process :');
      terminate("Received Exit");
    }
  }
});

/**
 * 
 * @param {*} obj 
 * @param {*} key 
 * @param {*} value 
 * @returns 
 * Function to Serch Multi Dimission Array
 */
const findObject = (obj = {}, key, value) => {
  const result = [];
  const recursiveSearch = (obj = {}) => {
    if (!obj || typeof obj !== 'object') {
      return;
    };
    if (obj[key] === value) {
      result.push(obj);
    };
    Object.keys(obj).forEach(function (k) {
      recursiveSearch(obj[k]);
    });
  }
  recursiveSearch(obj);
  return result;
}

/**
 * 
 * Main function
 */
main = async () => {
  await getToken();
  task.start();
  // Get template asset
  let getTempAsset = await checkTempAsset();
  // Get languages
  let getLangAsset = await checkLangAsset();
  if (getTempAsset !== false && getLangAsset !== false) {
    let tempAssetObj = await templateAsset.getData("/asset");
    // Read key mapping config
    let config_key_mapping_obj = findObject(tempAssetObj, 'fieldName', 'config_key_mapping');
    // Read language mapping config
    let config_language_mapping_obj = findObject(tempAssetObj, 'fieldName', 'config_language_mapping');
    // Read otype mapping
    let config_otype_mapping_obj = findObject(tempAssetObj, 'fieldName', 'config_otype_mapping');

    if (config_key_mapping_obj.hasOwnProperty('0') && config_key_mapping_obj[0].localizedValues.hasOwnProperty('0')) {
      await kMap.push("/", JSON.parse(config_key_mapping_obj[0].localizedValues[0].value));
      await kMap.save();
    }

    if (config_language_mapping_obj.hasOwnProperty('0') && config_language_mapping_obj[0].localizedValues.hasOwnProperty('0')) {
      await langMap.push("/", JSON.parse(config_language_mapping_obj[0].localizedValues[0].value));
      await langMap.save();
    }

    if (config_otype_mapping_obj.hasOwnProperty('0') && config_otype_mapping_obj[0].localizedValues.hasOwnProperty('0')) {
      await oTypes.push("/", JSON.parse(config_otype_mapping_obj[0].localizedValues[0].value));
      await oTypes.save();
    }

    logger.info('####### ' + ' ' + process.pid + ': Import Started at ' + new Date() + ' #########');
    if (fs.existsSync(APR_CREDENTIALS.checkin)) {
      let DEprocess = await readDeltaMasterExcel();
      /*
      // Read excel file if exists
      let REprocess = await readExcel(0);
      logger.info('####### createRelation Started at ' + new Date() + ' #########');
      // Create relation
      let CRprocess = await createRelation();
      logger.info('####### createRelation Ended at ' + new Date() + ' #########');
      // Create language relation for parent
      logger.info('####### createLanguageRelationParent Started at ' + new Date() + ' #########');
      let CLRPprocess = await createLanguageRelationParent();
      logger.info('####### createLanguageRelationParent Ended at ' + new Date() + ' #########');
      // Create language relation for child
      logger.info('####### createLanguageRelationChild Started at ' + new Date() + ' #########');
      let CLRCprocess = await createLanguageRelationChild();
      logger.info('####### createLanguageRelationChild Ended at ' + new Date() + ' #########');

      if (REprocess && CRprocess && CLRPprocess && CLRCprocess) {
        // End process with success reference
        await endProcess(pJobID, true);
        logger.info('####### Import Ended for ' + pJobID + ' at ' + new Date() + ' #########');
      } else {
        // End process with fail reference
        await endProcess(pJobID, false);
        logger.info('####### Import Ended with ERROR for ' + pJobID + ' at ' + new Date() + ' #########');
      }
      */
      terminate('Normal Close');
    } else {
      await downloadCSVFromFtp();
      terminate('Normal Close');
    }

    logger.info('####### ' + ' ' + process.pid + ': Import Ended at ' + new Date() + ' #########');
  } else {
    logger.error('####### Sample Asset Not Found ' + new Date() + ' #########');
    logger.error('####### Stop Further Processing ' + new Date() + ' #########');
    terminate('Normal Close');
  }
};

function terminate(code){
  if(fs.existsSync(APR_CREDENTIALS.signature)){
    fs.unlink(APR_CREDENTIALS.signature, (err) => {
      if (err) {
        logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING IN DELETE FILE:' + APR_CREDENTIALS.signature);
      }
    });
    if(code === 'Normal Close'){
      logger.info(new Date() + ': System -- ' + code);
    }else{
      logger.error(new Date() + ': System ERROR -- ' + code);
    }    
  }
  task.stop();
  process.exit(0);
}

process.on('SIGTERM', signal => {
  console.log('Received SIGTERM');
	terminate("Received SIGTERM");
})

process.on('SIGINT', signal => {
  console.log('Received SIGINT');
	terminate("Received SIGINT");
})

process.on('uncaughtException', err => {
  console.log('Caught exception: ', err);
	terminate('Caught exception: ' + err);
})

process.on('unhandledRejection', (reason, p) => {
  console.log("Unhandled Rejection at: " + p + ' reason: ' + reason);
  terminate("Unhandled Rejection at: " + p + ' reason: ' + reason);
});


// Function to check if the file is older than 2 hours
function isFileOlderThanHours(filePath) {
  const HoursInMilliseconds = 3 * 60 * 60 * 1000; // Convert 3 hours to milliseconds
  // Get the file's information
  const fileStats = fs.statSync(filePath);
  // Calculate the timestamp for 3 hours ago
  const HoursAgo = new Date().getTime() - HoursInMilliseconds;
  // Compare the file's modification timestamp with the calculated timestamp
  if (fileStats.mtimeMs < HoursAgo) {
    return true; // File is older than 3 hours
  } else {
    return false; // File is not older than 3 hours
  }
}

/**
 * 
 * Calling main function
 */
try {
  //Check for running process
  if(fs.existsSync(APR_CREDENTIALS.signature)){
    //Check for running checking file
    if(fs.existsSync(APR_CREDENTIALS.checkin)){
      if(isFileOlderThanHours(APR_CREDENTIALS.checkin)){
        // Delete checkindata file to restart process.
        logger.info(new Date() + ': ' + process.pid + ': Reset Process :');  
        terminate('Reset Process ');
      }else{
        logger.info(new Date() + ': ' + process.pid + ': Skipping : Already Running :');
        task.stop();
      }
    }else{
      logger.info(new Date() + ': ' + process.pid + ': Skipping : Already Running :');
      task.stop();
    }
  }else{
    logger.info(new Date() + ': ' + process.pid + ': Start : ********** :');
    let fd = fs.openSync(APR_CREDENTIALS.signature, 'w');
    main();
  }
} catch (error) {
  logger.error(new Date() + ': ' + process.pid +': System ERROR -- ' + error);
  task.stop();
}