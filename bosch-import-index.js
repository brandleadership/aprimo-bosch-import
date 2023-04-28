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

const {
  v4: uuidv4
} = require('uuid');

const APR_CREDENTIALS = JSON.parse(fs.readFileSync("aprimo-credentials.json"));

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
 * 
 * Create a checkin excel file from the JSON data
 * @param {*} jobID
 */  
async function JSONtoCheckInData(jobID) {  
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
};


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

/**
 * Download CSV files from the FTP
 */
downloadCSVFromFtp = async () => {
  let ftpDirectory = APR_CREDENTIALS.targetPath;
  // Read FTP directory for CSV files
  fs.readdir(ftpDirectory, (err, files) => {
    if (err) throw err;

    for (const file of files) {
      if (file.match(/.+(\.csv)$/)) {
        // Delete CSV files from FTP directory
        fs.unlink(path.join(ftpDirectory, file), (err) => {
          if (err) throw err;
        });
      }
    }
  });
  fs.readdir(APR_CREDENTIALS.imgFolderPath, (err, files) => {
    if (err) throw err;

    for (const file of files) {
      // Delete all downloaded files
      fs.unlink(path.join(APR_CREDENTIALS.imgFolderPath, file), (err) => {
        if (err) throw err;
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
      //process listed files
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
            let fd = fs.openSync(dst + '/' + jobID + '.finished', 'w');
            const csvfiles = await sftp.list(src + '/' + jobID + '/.');

            for (var i = 0, len = csvfiles.length; i < len; i++) {
              if (csvfiles[i].name.match(/.+(\.csv)$/)) {    
                await sftp.fastGet(src + '/' + jobID + '/' + csvfiles[i].name, dst + '/' + csvfiles[i].name);
              }
            }

            await JSONtoCheckInData(jobID);
            await readExcel();
            await createRelation();
            await createLanguageRelationParent();
            await createLanguageRelationChild();
            await endProcess(jobID);
          }
        }
      }


    }).catch(e => {
      logger.info(new Date() + ': Error: Download CSV FromFtp: ' + e.message);
      console.log(new Date() + ': Error: Download CSV FromFtp: ' + e.message);
    });
  sftp.end();
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
        if (row?.appstatus !== 'checkin' && row?.appstatus !== 'linked') {
          cpuIndex++;
          csvData[index].appstatus = 'checkin';
          csvData[index].index = index;
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
              let timeStamp = new Date();
              csvData[result[r].rowdata.index].processdate = timeStamp.toLocaleString();
              csvData[result[r].rowdata.index].message = result[r].message;
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
          let timeStamp = new Date();
          csvData[result[r].rowdata.index].processdate = timeStamp.toLocaleString();
          csvData[result[r].rowdata.index].message = result[r].message;
        }
        poolArray = [];
        await writeExcel(csvData, 'null');
      }else{
        await writeExcel(csvData, 'null');
      }
    }

  } catch (e) {
    logger.info(new Date() + ': Error: Read Excel File: ' + e.message);
    console.log(new Date() + ': Error: Read Excel File: ' + e.message);
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
      const maserData = csvData.filter((row) => row['MASTER_RECORD'] === 'x' && row['recordID'] != '');
      let index = 0;
      let cpuIndex = 0;
      let poolArray = [];

      for (const masterDataRow of maserData) {
        if (masterDataRow?.appstatus === 'checkin') {
          cpuIndex++;
          csvData[masterDataRow.index].appstatus = 'linked';
          csvData[masterDataRow.index].index = index;
          
          const childData = csvData.filter((row) => row['OBJ_ID'] === masterDataRow.OBJ_ID && row['recordID'] != '' && row['MASTER_RECORD'] != 'x');
          let childRecordID = [];
          for (const childDataRow of childData) {
            childRecordID.push(childDataRow.recordID);
          }


          logger.info(new Date() + ': createRelation OBJ_ID: '+ masterDataRow.OBJ_ID);

          poolArray.push(pool.run({
            rowdata: {
              masterRecordID: masterDataRow.recordID,
              childRecordID: childRecordID
            },
            mode: 'linkRecords'
          }, options));
          if (cpuIndex === APR_CREDENTIALS.worker * 10) {

            //logger.info(new Date() + ': Start pool: ');
            const result = await Promise.all(poolArray);
            //logger.info(new Date() + ': End pool: ');

            //console.log("result", result);
            cpuIndex = 0;
            poolArray = [];
            //logger.info(new Date() + ': Start wrtie: ');
            //await writeExcel(csvData, 'null');
            //logger.info(new Date() + ': End wrtie: ');

          }
        }
        index++;
      }
      //Process remaining
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        console.log("result", result);
        poolArray = [];
        await writeExcel(csvData, 'null');
      }else{
        await writeExcel(csvData, 'null');
      }
    }
  } catch (e) {
    logger.info(new Date() + ': Error: createRelation: ' + e.message);
    console.log(new Date() + ': Error: createRelation: ' + e.message);
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
        const childData = csvData.filter((row) => row['OBJ_ID'] === masterDataRow.RELATED_DOCUMENT && row['recordID'] != '');
        let childRecordID = [];
        for (const childDataRow of childData) {
          childRecordID.push(childDataRow.recordID);
        }
        logger.info(new Date() + ': LanguageRelationParent OBJ_ID: '+ masterDataRow.OBJ_ID);

        if (childRecordID.length > 0) {
          poolArray.push(pool.run({
            rowdata: {
              masterRecordID: masterDataRow.recordID,
              childRecordID: childRecordID
            },
            mode: 'LanguageRelationParent'
          }, options));
          if (cpuIndex === APR_CREDENTIALS.worker * 10) {
            const result = await Promise.all(poolArray);
            console.log("result", result);
            cpuIndex = 0;
            poolArray = [];
            //await writeExcel(csvData);
          }
        }
        index++;
      }

      //Process remaining
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        console.log("result", result);
        poolArray = [];
        //await writeExcel(csvData, 'null');
      }
    }
  } catch (e) {
    logger.info(new Date() + ': Error: createLanguageRelationParent: ' + e.message);
    console.log(new Date() + ': Error: createLanguageRelationParent: ' + e.message);
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
            const childData = csvData.filter((row) => row['OBJ_ID'] === str_array[str] && row['recordID'] != '');
            for (const childDataRow of childData) {
              childRecordID.push(childDataRow.recordID);
            }
          }
          logger.info(new Date() + ': LanguageRelationChild OBJ_ID: '+ masterDataRow.OBJ_ID);

          if (childRecordID.length > 0) {
            poolArray.push(pool.run({
              rowdata: {
                masterRecordID: masterDataRow.recordID,
                childRecordID: childRecordID
              },
              mode: 'LanguageRelationChild'
            }, options));
            if (cpuIndex === APR_CREDENTIALS.worker * 10) {
              const result = await Promise.all(poolArray);
              console.log("result", result);
              cpuIndex = 0;
              poolArray = [];
              //await writeExcel(csvData);
            }
          }
        }
        index++;
      }

      //Process remaining
      if (poolArray.length > 0) {
        const result = await Promise.all(poolArray);
        console.log("result", result);
        poolArray = [];
        //await writeExcel(csvData, 'null');
      }
    }
  } catch (e) {
    logger.info(new Date() + ': Error: createLanguageRelationChild: ' + e.message);
    console.log(new Date() + ': Error: createLanguageRelationChild: ' + e.message);
  }
}

/**
 * 
 * endProcess
 */  

async function endProcess(jobID) {
  try {
    let fileName = APR_CREDENTIALS.targetPath + '/' + jobID + '_' + uuidv4() + '.xlsx';
    fs.rename(APR_CREDENTIALS.checkin, fileName, function (err) {
      if (err) throw err;
    });

    let ftpDirectory = APR_CREDENTIALS.targetPath;
    await fs.readdir(ftpDirectory, async (err, files) => {
      if (err) throw err;
  
      for (const file of files) {
        if (file.match(/.+(\.finished)$/)) {
          let jsonData;
          const dst = APR_CREDENTIALS.targetPath;
          const src = APR_CREDENTIALS.sourcePath;
          let sftp = new Client();

          let fd = fs.openSync(dst + '/' + path.parse(file).name  + '.importFinished', 'w');
          jsonData = await sftp.connect(ftpConfig)
            .then(async () => {        
              await sftp.put(dst + '/' + path.parse(file).name  + '.importFinished', src + '/' + path.parse(file).name  + '.importFinished');
            }).catch(e => {
              logger.info(new Date() + ': Error: Updating File Name in FTP Server ' + e.message);
              console.log(new Date() + ': Error: Updating File Name in FTP Server ' + e.message);
            });
          sftp.end();
          
          fs.unlink(path.join(ftpDirectory, file), (err) => {
            if (err) throw err;
          });

        }
      }
    });

    terminate('Normal Close');


  } catch (e) {
    logger.info(new Date() + ': Error: endProcess: ' + e.message);
    console.log(new Date() + ': Error: endProcess: ' + e.message);
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
    console.log(new Date() + ': Error: writeExcel: ' + e.message);
  }

}

/**
 * 
 * main function
 */  

main = async () => {
  console.log('####### Import Started at ' + new Date() + ' #########');
  logger.info('####### Import Started at ' + new Date() + ' #########');

  
  if (fs.existsSync(APR_CREDENTIALS.checkin)) {
    await readExcel();
    console.log('####### createRelation Started at ' + new Date() + ' #########');
    logger.info('####### createRelation Started at ' + new Date() + ' #########');  
    await createRelation();
    console.log('####### createRelation Ended at ' + new Date() + ' #########');
    logger.info('####### createRelation Ended at ' + new Date() + ' #########');

    console.log('####### createLanguageRelationParent Started at ' + new Date() + ' #########');
    logger.info('####### createLanguageRelationParent Started at ' + new Date() + ' #########');  
    await createLanguageRelationParent();
    console.log('####### createLanguageRelationParent Ended at ' + new Date() + ' #########');
    logger.info('####### createLanguageRelationParent Ended at ' + new Date() + ' #########');

    console.log('####### createLanguageRelationChild Started at ' + new Date() + ' #########');
    logger.info('####### createLanguageRelationChild Started at ' + new Date() + ' #########');  
    await createLanguageRelationChild();
    console.log('####### createLanguageRelationChild Ended at ' + new Date() + ' #########');
    logger.info('####### createLanguageRelationChild Ended at ' + new Date() + ' #########');

    await endProcess();
  } else {
    await downloadCSVFromFtp();
  }

  console.log('####### Import Ended at ' + new Date() + ' #########');
  logger.info('####### Import Ended at ' + new Date() + ' #########');

};


function terminate(code){
  if(fs.existsSync(APR_CREDENTIALS.signature)){
    fs.unlink(APR_CREDENTIALS.signature, (err) => {
      if (err) throw err;
    });
    console.log(`Process exited with code: ${code}`)  
    logger.error(new Date() + ': System -- ' + code);
  }
}

/*
process.on('beforeExit', code => {
	//terminate(code);
})

process.on('exit', code => {
	//terminate(code);
})
*/

process.on('SIGTERM', signal => {
  console.log('SIGTERM: ');
	terminate(process.pid);
	process.exit(0)
})

process.on('SIGINT', signal => {
  console.log('SIGINT: ');
	terminate(process.pid);
	process.exit(0)
})

process.on('uncaughtException', err => {
  console.log('Caught exception: ', err);
	terminate(process.pid);
	process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.log('unhandledRejection: ');
	terminate(process.pid);
	process.exit(1)
})

/**
 * 
 * Calling main function
 */

try {
  if(fs.existsSync(APR_CREDENTIALS.signature)){
    console.log(new Date() + ': Skipping : Already Running :');
    logger.info(new Date() + ': Skipping : Already Running :');
  }else{
    console.log(new Date() + ': Start : ********** :');
    logger.info(new Date() + ': Start : ********** :');
    let fd = fs.openSync(APR_CREDENTIALS.signature, 'w');
    main();
  }
} catch (error) {
  console.log(new Date() + ': System Error -- ' + error);
  logger.error(new Date() + ': System Error -- ' + error);
}

