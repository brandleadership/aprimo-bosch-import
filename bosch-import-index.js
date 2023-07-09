const Piscina = require('piscina')
var path = require("path");
let Client = require("ssh2-sftp-client");
const csv = require("csvtojson");
const XLSX = require('xlsx');
var fs = require("fs");
const ftpConfig = JSON.parse(fs.readFileSync("ftp.json"));
const winston = require("winston");
require('winston-daily-rotate-file');
const arrayApp = require('lodash');
const axios = require("axios").default;
const HttpsProxyAgent = require('https-proxy-agent');
const { JsonDB, Config } = require('node-json-db');
const dbtoken = new JsonDB(new Config("apitoken", true, true, '/'));
const templateAsset = new JsonDB(new Config("template", true, true, '/'));
const cron = require('node-cron');
const os = require('os');
const cpus = os.cpus();
let pJobID = 'job_000000';

const {
  v4: uuidv4
} = require('uuid');

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
 * Create a checkin excel file from the JSON data
 * @param {*} jobID
 */  
async function JSONtoCheckInData(jobID) {  
  try{
    // Get All CSV files from FTP Target Path
    const csvInDir = fs
      .readdirSync(APR_CREDENTIALS.targetPath)
      .filter((file) => path.extname(file) === ".csv");

    let csvFileData = [];
    for (var i = 0, len = csvInDir.length; i < len; i++) {
      var file = csvInDir[i];
      if (file) {
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
    // Write Excel File
    await writeExcel(csvFileData, jobID);

    return true;
  } catch (e) {
    logger.info(new Date() + ': Error: Write Excel File: ' + e.message);
    //console.log(new Date() + ': Error: Read Excel File: ' + e.message);
    return false;
  }
};



/**
 * Download CSV files from the FTP
 */
downloadCSVFromFtp = async () => {
  let ftpDirectory = APR_CREDENTIALS.targetPath;
  // Read FTP directory for CSV files
  fs.readdir(ftpDirectory, (err, files) => {
    if (err) {
      logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING READ DIRECTORY');
    }

    for (const file of files) {
      if (file.match(/.+(\.csv)$/)) {
        // Delete CSV files from FTP directory
        fs.unlink(path.join(ftpDirectory, file), (err) => {
          if (err){
            logger.info(new Date() + ' JobID: ' + jobID + ' : WARNING DELETE FILE');
          }
        });
      }
    }
  });
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
  //connect SFTP
  jsonData = await sftp.connect(ftpConfig)
    .then(async () => {
      const files = await sftp.list(src + '/.');
      files.sort((a,b) => a.name.localeCompare(b.name));
      //process listed files
      sftp.end();
      for (var i = 0, len = files.length; i < len; i++) {
        if (files[i].name.match(/.+(\.finished)$/)) {
          let jobID = path.parse(files[i].name).name;
          let importFinished = false;
          importFinished = arrayApp.find(files, function(obj) {
            if (obj.name === jobID + '.importFinished') {
                return true;
            }
          });
          if(!importFinished){   
            // Create .finished file for reference 
            logger.info('####### Import Started for ' + jobID + ' at ' + new Date() + ' #########');
            let fd = fs.openSync(dst + '/' + jobID + '.finished', 'w');
            let sftpSub = new Client();
            await sftpSub.connect(ftpConfig).then(async () => {
              const csvfiles = await sftpSub.list(src + '/' + jobID + '/.');
              for (var j = 0, csvlen = csvfiles.length; j < csvlen; j++) {
                if (csvfiles[j].name.match(/.+(\.csv)$/)) {    
                  await sftpSub.fastGet(src + '/' + jobID + '/' + csvfiles[j].name, dst + '/' + csvfiles[j].name);
                }
              }  
            }).catch(e => {
              logger.info(new Date() + ': Error: In FTP Connection: ' + e.message);
              //console.log(new Date() + ': Error: Download CSV FromFtp: ' + e.message);
            });
            sftpSub.end();

            let JSONprocess = await JSONtoCheckInData(jobID);
            let REprocess = await readExcel();
            let CRprocess = await createRelation();
            let CLRPprocess = await createLanguageRelationParent();
            let CLRCprocess = await createLanguageRelationChild();
            
            if(JSONprocess && REprocess && CRprocess && CLRPprocess && CLRCprocess){
              await endProcess(jobID, true);
              logger.info('####### Import Ended for ' + jobID + ' at ' + new Date() + ' #########');
            }else{
              await endProcess(jobID, false);
              logger.info('####### Import Ended with Error for ' + jobID + ' at ' + new Date() + ' #########');
            }
            
          }
        }
      }


    }).catch(e => {
      logger.info(new Date() + ': Error: In FTP Connection: ' + e.message);
      //console.log(new Date() + ': Error: Download CSV FromFtp: ' + e.message);
    });
  
  return jsonData;
};

/**
 * 
 * readExcel to process further. 
 */  

async function readExcel() {
  try {
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    const sheets = file.SheetNames;
    //Read Excel Sheets
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
        if (row?.appstatus !== 'checkin' && row?.appstatus !== 'linked') {
          cpuIndex++;
          row.appstatus = 'checkin';
          //csvData[index].index = index;
          pJobID = row.JOB_ID;
          // Create pool records
          poolArray.push(pool.run({
            rowdata: row,
            mode: 'createRecords'
          }, options));
          if (cpuIndex === APR_CREDENTIALS.worker * 10) {
            const result = await Promise.all(poolArray)
            cpuIndex = 0;
            poolArray = [];
            for (let r = 0; r < result.length; r++) {
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
          await writeExcel(csvData, 'null');
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
        await writeExcel(csvData, 'null');
      }else{
        await writeExcel(csvData, 'null');
      }
    }
    return true;
  } catch (e) {
    logger.info(new Date() + ': Error: Read Excel File: ' + e.message);
    //console.log(new Date() + ': Error: Read Excel File: ' + e.message);
    return false;
  }
}

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
      const maserData = csvData.filter((row) => row['MASTER_RECORD'] === 'x' && row['recordID'] != '' && row['recordID'] != 0);
      let index = 0;
      let cpuIndex = 0;
      let poolArray = [];

      for (const masterDataRow of maserData) {        
        if (masterDataRow?.appstatus === 'checkin') {
          cpuIndex++;          
          const childData = csvData.filter((row) => row['OBJ_ID'] === masterDataRow.OBJ_ID && row['recordID'] != '' && row['recordID'] != 0 && row['MASTER_RECORD'] != 'x');
          let childRecordID = [];
          for (const childDataRow of childData) {
            childRecordID.push(childDataRow.recordID);
          }

          poolArray.push(pool.run({
            rowdata: {
              masterRecordID: masterDataRow.recordID,
              masterData: masterDataRow,
              childRecordID: childRecordID
            },
            mode: 'linkRecords'
          }, options));
          if (cpuIndex === APR_CREDENTIALS.worker * 10) {
            const result = await Promise.all(poolArray);
            cpuIndex = 0;
            poolArray = [];
          }
        }
        index++;
      }
      //Process remaining
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        poolArray = [];
        await writeExcel(csvData, 'null');
      }else{
        await writeExcel(csvData, 'null');
      }
    }

    return true;
  } catch (e) {
    logger.info(new Date() + ': Error: createRelation: ' + e.message);
    //console.log(new Date() + ': Error: createRelation: ' + e.message);
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
      const maserData = csvData.filter((row) => row['RELATED_DOCUMENT'] != '');
      let index = 0;
      let cpuIndex = 0;
      let poolArray = [];

      for (const masterDataRow of maserData) {
        cpuIndex++;
        const childData = csvData.filter((row) => row['OBJ_ID'] === masterDataRow.RELATED_DOCUMENT && row['recordID'] != '' && row['recordID'] != 0);
        let childRecordID = [];
        for (const childDataRow of childData) {
          childRecordID.push(childDataRow.recordID);
        }
        //logger.info(new Date() + ': LanguageRelationParent OBJ_ID: '+ masterDataRow.OBJ_ID);

        if (childRecordID.length > 0) {
          poolArray.push(pool.run({
            rowdata: {
              masterRecordID: masterDataRow.recordID,
              masterData: masterDataRow,
              childRecordID: childRecordID
            },
            mode: 'LanguageRelationParent'
          }, options));
          if (cpuIndex === APR_CREDENTIALS.worker * 10) {
            const result = await Promise.all(poolArray);
            cpuIndex = 0;
            poolArray = [];
          }
        }
        index++;
      }

      //Process remaining
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        poolArray = [];
      }
    }

    return true;
  } catch (e) {
    logger.info(new Date() + ': Error: createLanguageRelationParent: ' + e.message);
    //console.log(new Date() + ': Error: createLanguageRelationParent: ' + e.message);
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
      const maserData = csvData.filter((row) => row['RELATED_DOCUMENT[USAGE]'] != '');
      let index = 0;
      let cpuIndex = 0;
      let poolArray = [];

      for (const masterDataRow of maserData) {
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
          //logger.info(new Date() + ': LanguageRelationChild OBJ_ID: '+ masterDataRow.OBJ_ID);

          if (childRecordID.length > 0) {
            poolArray.push(pool.run({
              rowdata: {
                masterRecordID: masterDataRow.recordID,
                masterData: masterDataRow,
                childRecordID: childRecordID
              },
              mode: 'LanguageRelationChild'
            }, options));
            if (cpuIndex === APR_CREDENTIALS.worker * 10) {
              const result = await Promise.all(poolArray);
              cpuIndex = 0;
              poolArray = [];
            }
          }
        }
        index++;
      }

      //Process remaining
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        poolArray = [];
      }
    }

    return true;
  } catch (e) {
    logger.info(new Date() + ': Error: createLanguageRelationChild: ' + e.message);
    //console.log(new Date() + ': Error: createLanguageRelationChild: ' + e.message);
    return false;
  }
}

/**
 * 
 * endProcess
 */  

async function endProcess(jobID, pStatus) {
  try {
    const fileNameDatetime = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-").replace("T", "_").replace("Z", "");
    let fileName = APR_CREDENTIALS.targetPath + '/' + jobID + '_' + fileNameDatetime + '.xlsx';
    fs.rename(APR_CREDENTIALS.checkin, fileName, function (err) {
      if (err){
        logger.error(new Date() + ' JobID: ' + jobID + ' : ERROR IN RENAME');
      }
    });

    let ftpDirectory = APR_CREDENTIALS.targetPath;
    await fs.readdir(ftpDirectory, async (err, files) => {
      if (err){
        logger.error(new Date() + ' JobID: ' + jobID + ' : ERROR IN READ DIRECTORY');
      };
  
      for (const file of files) {
        if (file.match(/.+(\.finished)$/)) {
          
          const dst = APR_CREDENTIALS.targetPath;
          const src = APR_CREDENTIALS.sourcePath;
          let sftp = new Client();
          let fd = fs.openSync(dst + '/' + path.parse(file).name  + '.importFinished', 'w');
          let jsonData = await sftp.connect(ftpConfig)
            .then(async () => {        
              await sftp.put(dst + '/' + path.parse(file).name  + '.importFinished', src + '/' + path.parse(file).name  + '.importFinished');
              if(pStatus){



                const csvfile = XLSX.readFile(fileName);
                const sheets = csvfile.SheetNames;
                for (let i = 0; i < sheets.length; i++) {
                  const csvData = XLSX.utils.sheet_to_json(csvfile.Sheets[csvfile.SheetNames[i]], {
                    defval: ""
                  });

                  const appStatus = csvData.filter((row) => row['appstatus'] === 'error');
                  if(appStatus.length > 0){
                    logger.info(new Date() + ' JobID: ' + jobID + ' : Row Has Error Moving to Error Folder');
                    await sftp.rename(src + '/' + jobID, src + '/../errors/' + jobID);
                    await sftp.rename(src + '/' + jobID + '.finished', src + '/../errors/' + jobID + '.finished');
                    await sftp.rename(src + '/' + jobID + '.importFinished', src + '/../errors/' + jobID + '.importFinished');
                    await sftp.rename(src + '/' + jobID + '.started', src + '/../errors/' + jobID + '.started');  
                  }else{
                    logger.info(new Date() + ' JobID: ' + jobID + ' : No Error Found Moving to Completed Folder');
                    await sftp.rename(src + '/' + jobID, src + '/../completed/' + jobID);
                    await sftp.rename(src + '/' + jobID + '.finished', src + '/../completed/' + jobID + '.finished');
                    await sftp.rename(src + '/' + jobID + '.importFinished', src + '/../completed/' + jobID + '.importFinished');
                    await sftp.rename(src + '/' + jobID + '.started', src + '/../completed/' + jobID + '.started');      
                  }
                }
              }else{
                logger.info(new Date() + ' JobID: ' + jobID + ' : Process Error Moving to Error Folder');
                await sftp.rename(src + '/' + jobID, src + '/../errors/' + jobID);
                await sftp.rename(src + '/' + jobID + '.finished', src + '/../errors/' + jobID + '.finished');
                await sftp.rename(src + '/' + jobID + '.importFinished', src + '/../errors/' + jobID + '.importFinished');
                await sftp.rename(src + '/' + jobID + '.started', src + '/../errors/' + jobID + '.started');  
              }
            }).catch(async (e) => {
              logger.info(new Date() + ': Error: Updating File Name in FTP Server ' + e.message);
              //console.log(new Date() + ': Error: Updating File Name in FTP Server ' + e.message);
              try {
                await sftp.rename(src + '/' + jobID, src + '/../errors/' + jobID);
                await sftp.rename(src + '/' + jobID + '.finished', src + '/../errors/' + jobID + '.finished');
                await sftp.rename(src + '/' + jobID + '.importFinished', src + '/../errors/' + jobID + '.importFinished');
                await sftp.rename(src + '/' + jobID + '.started', src + '/../errors/' + jobID + '.started');                  
              } catch (error) {
                logger.info(new Date() + ': Error: Moving Files to Error Folder');
              }
            });
          sftp.end();
          
          fs.unlink(path.join(ftpDirectory, file), (err) => {
            if (err) {
              logger.error(new Date() + ' JobID: ' + jobID + ' : ERROR IN DELETE FILE');
            };
          });
        }

        if (path.extname(file) === '.csv') {
          fs.unlink(path.join(ftpDirectory, file), err => {
            if (err) {
              logger.error(new Date() + ' JobID: ' + jobID + ' : ERROR IN DELETE FILE');
            }
          });
        }
      }
    });
  } catch (e) {
    logger.info(new Date() + ': Error: endProcess: ' + e.message);
    //console.log(new Date() + ': Error: endProcess: ' + e.message);
  }
}

/**
 * 
 * writeExcel file from the JSON object
 */  
async function writeExcel(jsonArray, jobID) {
  try {
    if(jobID !== 'null'){
      jsonArray[0].JOB_ID = '';
    }

    let arrayKeys = [];
    jsonArray.forEach((row) => {
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
    XLSX.writeFile(workbook, APR_CREDENTIALS.checkin);

  } catch (e) {
    logger.info(new Date() + ': Error: writeExcel: ' + e.message);
    //console.log(new Date() + ': Error: writeExcel: ' + e.message);
  }

}


/**
 * Search for Template Record with JOB-ID: job_999999999 and KBObjectID: 999999999 
 * @param {*} File Name, CSV Row Data, token
 */
searchTemplateAsset = async (token) => {

  let queryString = '';
  queryString = "'999999999'" + " and FieldName('mpe_job_id') = 'job_999999999'";

  logger.info(new Date() + ': SearchTemplateAsset: ');
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
        logger.info(new Date() + ': ERROR: SearchTemplateAsset Not Found ');
      } else if (itemsObj.totalCount === 1) {
          logger.info(new Date() + ': SearchTemplateAsset ID:'+ itemsObj.items[0].id );
          getFieldsResult = itemsObj.items[0].id;
      }else{
        logger.info(new Date() + ': ERROR: SearchTemplateAsset Not Found ');
      }
      return getFieldsResult;
    })
    .catch(async (err) => {
      logger.info(new Date() + ': ERROR: SearchTemplateAsset Not Found ');
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
  let tempAssetID = await searchTemplateAsset(token);
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
        await templateAsset.push("/asset", resp.data.items);
        await templateAsset.save();
        return true;
      } else {
        logger.error(new Date() + ': ERROR : tempAssetID Missing --');
        //console.log(new Date() + ': ERROR : tempAssetID Missing --');
        return false;
      }
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
      return false;
    });
      return getFieldsResult;
    }else{
      return false;
    }
  
};


/**
 * Generating Token
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
      //console.log("resp", resp);
      logger.info(new Date() + ': API Token Generated: ###################################');
      return resp.data;
    })
    .catch(async (err) => {    
      //console.log("err", err);
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
      await dbtoken.push("/token", resultAssets.accessToken);
      await dbtoken.save();
      return resultAssets;
    }else{
      return 'null';
    }
};


let task = cron.schedule("*/5 * * * *", async () => {
  //console.log("running a task every 5 Min");
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
 * main function
 */  

main = async () => {
  await getToken();
  task.start();

  let getTempAsset = await checkTempAsset();
  //console.log("getTempAsset", getTempAsset);
  if(getTempAsset !== false){
      //console.log('####### Import Started at ' + new Date() + ' #########');
      logger.info('####### '+ ' ' + process.pid + ': Import Started at ' + new Date() + ' #########');
      if (fs.existsSync(APR_CREDENTIALS.checkin)) {
        let REprocess = await readExcel();
        //console.log('####### createRelation Started at ' + new Date() + ' #########');
        logger.info('####### createRelation Started at ' + new Date() + ' #########');  
        let CRprocess = await createRelation();
        //console.log('####### createRelation Ended at ' + new Date() + ' #########');
        logger.info('####### createRelation Ended at ' + new Date() + ' #########');

        //console.log('####### createLanguageRelationParent Started at ' + new Date() + ' #########');
        logger.info('####### createLanguageRelationParent Started at ' + new Date() + ' #########');  
        let CLRPprocess = await createLanguageRelationParent();
        //console.log('####### createLanguageRelationParent Ended at ' + new Date() + ' #########');
        logger.info('####### createLanguageRelationParent Ended at ' + new Date() + ' #########');

        //console.log('####### createLanguageRelationChild Started at ' + new Date() + ' #########');
        logger.info('####### createLanguageRelationChild Started at ' + new Date() + ' #########');  
        let CLRCprocess = await createLanguageRelationChild();
        //console.log('####### createLanguageRelationChild Ended at ' + new Date() + ' #########');
        logger.info('####### createLanguageRelationChild Ended at ' + new Date() + ' #########');

        if(REprocess && CRprocess && CLRPprocess && CLRCprocess){
          await endProcess(pJobID, true);
          logger.info('####### Import Ended for ' + pJobID + ' at ' + new Date() + ' #########');
        }else{
          await endProcess(pJobID, false);
          logger.info('####### Import Ended with Error for ' + pJobID + ' at ' + new Date() + ' #########');
        }
        terminate('Normal Close');
      } else {
        await downloadCSVFromFtp();
        terminate('Normal Close');
      }

      //console.log('####### Import Ended at ' + new Date() + ' #########');
      logger.info('####### '+ ' ' + process.pid + ': Import Ended at ' + new Date() + ' #########');

  }else{
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
    //console.log(`Process exited with code: ${code}`)  
    if(code === 'Normal Close'){
      logger.info(new Date() + ': System -- ' + code);
    }else{
      logger.error(new Date() + ': System -- ' + code);
    }    
  }
  task.stop();
  process.exit(0);
}

/*
process.on('beforeExit', code => {
	task.stop();
})
process.on('exit', code => {
	task.stop();
  //console.log('Received Exit');
  terminate("Received Exit");
})
*/

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
  //logger.info(new Date() + ': fileStats.mtimeMs ' + fileStats);
  //logger.info(new Date() + ': HoursAgo ' + HoursAgo);

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
  logger.error(new Date() + ': ' + process.pid +': System Error -- ' + error);
  task.stop();
}

