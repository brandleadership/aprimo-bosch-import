const Piscina = require('piscina')
var path = require("path");
let Client = require("ssh2-sftp-client");
const csv = require("csvtojson");
const XLSX = require('xlsx');
var fs = require("fs");
const ftpConfig = JSON.parse(fs.readFileSync("ftp.json"));
const winston = require("winston");
require('winston-daily-rotate-file');
const {
  v4: uuidv4
} = require('uuid');

const APR_CREDENTIALS = JSON.parse(fs.readFileSync("aprimo-credentials.json"));

// Create a new thread pool
const pool = new Piscina()
const options = { filename: 'aprimo-bosch-import.js' }

async function JSONtoCheckInData() {
    //console.log("Start");
    const csvInDir = fs
        .readdirSync(APR_CREDENTIALS.targetPath)
        .filter((file) => path.extname(file) === ".csv");

    for (var i = 0, len = csvInDir.length; i < len; i++) {
        var file = csvInDir[i];
        if (file) {
            const filePath = APR_CREDENTIALS.targetPath + "/" + file;
            const csvFileData = await csv({
                'delimiter': [';', ',']
            }).fromFile(filePath);
            await writeExcel(csvFileData);
        }
    }
};


/**
 * Log File
 */
var appError = new winston.transports.DailyRotateFile({
  level: 'error',
  name: 'error',
  filename: './logs/bosch-app-error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});
var appClassification = new winston.transports.DailyRotateFile({
  level: 'info',
  filename: './logs/bosch-app-classification-error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});
var appCombined = new winston.transports.DailyRotateFile({
  name: 'info',
  filename: './logs/bosch-app-combined-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});
var protocolsLogs = new winston.transports.DailyRotateFile({
  filename: './logs/bosch-app-protocols-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});
var tokensLogs = new winston.transports.DailyRotateFile({
  filename: './logs/bosch-app-uploaded-file-tokens-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  json: true,
  maxSize: '20m'
});

const logger = winston.createLogger({
  level: 'info',
  transports: [appError, appCombined]
});
const plogger = winston.createLogger({
  level: 'info',
  transports: [protocolsLogs]
});
const clogger = winston.createLogger({
  level: 'info',
  transports: [appClassification]
});
const tlogger = winston.createLogger({
  level: 'info',
  transports: [tokensLogs]
});
const logOptions = {
  from: new Date() - (168 * 60 * 60 * 1000),
  until: new Date(),
  limit: 100000,
  start: 0,
  order: 'desc',
  fields: ['message']
};

/**
 * Download CSV files from the FTP
 */
downloadCSVFromFtp = async () => {

  let ftpDirectory = APR_CREDENTIALS.targetPath;
  fs.readdir(ftpDirectory, (err, files) => {
    if (err) throw err;

    for (const file of files) {    
        if(file.match(/.+(\.csv)$/)){
          fs.unlink(path.join(ftpDirectory, file), (err) => {
            if (err) throw err;
          });    
        }
    }
  });

    var jsonData;
    const dst = APR_CREDENTIALS.targetPath;
    const src = APR_CREDENTIALS.sourcePath;
    let sftp = new Client();
    jsonData = await sftp.connect(ftpConfig)
        .then(async () => {
            const files = await sftp.list(src + '/.');
            for (var i = 0, len = files.length; i < len; i++) {
                if (files[i].name.match(/.+(\.csv)$/)) {
                    console.log("FTP:", files[i]);
                    await sftp.fastGet(src + '/' + files[i].name, dst + '/' + files[i].name);
                }
            }

            await JSONtoCheckInData();
        }).catch(e => {
            console.error(e.message);
        });
    sftp.end();
    return jsonData;
};

async function readExcel(){
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    
    const sheets = file.SheetNames;
    for (let i = 0; i < sheets.length; i++) {
        const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]], {defval:""});
        let index = 0;
        let cpuIndex = 0;
        let poolArray = [];
        for (const row of csvData) {
            if (row?.status !== 'checkin' && row?.status !== 'linked') {
                cpuIndex++;
                csvData[index].status = 'checkin';
                csvData[index].index = index;
                poolArray.push(pool.run({rowdata: row, mode: 'createRecords'}, options));
                if(cpuIndex === APR_CREDENTIALS.worker){
                    const result = await Promise.all(poolArray)
                    cpuIndex = 0;
                    poolArray = [];
                    for (let r = 0; r < result.length; r++) {
                        csvData[result[r].rowdata.index].recordID = result[r].recordID;
                        csvData[result[r].rowdata.index].processdate = new Date();
                    }
                    await writeExcel(csvData);
                }
            }
            index++;
        }

        //Process remaining
        if(poolArray.length > 0){
            const result = await Promise.all(poolArray)
            for (let r = 0; r < result.length; r++) {
                csvData[result[r].rowdata.index].recordID = result[r].recordID;
                csvData[result[r].rowdata.index].processdate = new Date();
            }
            poolArray = [];
            await writeExcel(csvData);
        }
    }
}

async function createRelation(){
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    const sheets = file.SheetNames;
    for (let i = 0; i < sheets.length; i++) {
        const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]], {defval:""});
        const maserData = csvData.filter((row) => row['MASTER_RECORD'] === 'x' && row['recordID'] != '');
        let index = 0;
        let cpuIndex = 0;
        let poolArray = [];

        for (const maserDataRow of maserData) {
            if (maserDataRow?.status === 'checkin') {
                cpuIndex++;
                csvData[maserDataRow.index].status = 'linked';
                csvData[maserDataRow.index].index = index;
                const childData = csvData.filter((row) => row['OBJ_ID'] === maserDataRow.OBJ_ID && row['recordID'] != '' && row['MASTER_RECORD'] != 'x');
                let childRecordID = [];
                for (const childDataRow of childData) {
                    childRecordID.push(childDataRow.recordID);
                }


                poolArray.push(pool.run({rowdata: {masterRecordID: maserDataRow.recordID, childRecordID: childRecordID}, mode: 'linkRecords'}, options));
                if(cpuIndex === APR_CREDENTIALS.worker){
                    const result = await Promise.all(poolArray);
                    console.log("result", result);
                    cpuIndex = 0;
                    poolArray = [];
                    await writeExcel(csvData);
                }
            }
            index++;
        }
        //Process remaining
        if(poolArray.length > 0){
          const result = await Promise.all(poolArray);
          console.log("result", result);
          poolArray = [];
          await writeExcel(csvData);
        }
    }
}

async function createLanguageRelationParent(){
  const file = XLSX.readFile(APR_CREDENTIALS.checkin);
  const sheets = file.SheetNames;
  for (let i = 0; i < sheets.length; i++) {
      const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]], {defval:""});
      const maserData = csvData.filter((row) => row['RELATED_DOCUMENT'] != '');
      let index = 0;
      let cpuIndex = 0;
      let poolArray = [];

      for (const maserDataRow of maserData) {
              cpuIndex++;              
              const childData = csvData.filter((row) => row['OBJ_ID'] === maserDataRow.RELATED_DOCUMENT && row['recordID'] != '');
              let childRecordID = [];
              for (const childDataRow of childData) {
                  childRecordID.push(childDataRow.recordID);
              }
              //console.log("maserData", maserDataRow.RELATED_DOCUMENT);
              //console.log("childRecordID", childRecordID);              
              if(childRecordID.length > 0){
                poolArray.push(pool.run({rowdata: {masterRecordID: maserDataRow.recordID, childRecordID: childRecordID}, mode: 'LanguageRelationParent'}, options));
                if(cpuIndex === APR_CREDENTIALS.worker){
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
      if(poolArray.length > 0){
        const result = await Promise.all(poolArray);
        console.log("result", result);
        poolArray = [];
        await writeExcel(csvData);
      }
  }
}

async function createLanguageRelationChild() {
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

    for (const maserDataRow of maserData) {
      cpuIndex++;
      if (typeof maserDataRow['RELATED_DOCUMENT[USAGE]'] === 'string') {
        var str_array = maserDataRow['RELATED_DOCUMENT[USAGE]'].split(',');
        let childRecordID = [];
        for (var str = 0; str < str_array.length; str++) {
          // Trim the excess whitespace.
          str_array[str] = str_array[str].replace(/^\s*/, "").replace(/\s*$/, "");
          const childData = csvData.filter((row) => row['OBJ_ID'] === str_array[str] && row['recordID'] != '');
          for (const childDataRow of childData) {
            childRecordID.push(childDataRow.recordID);
          }
        }
        if(childRecordID.length > 0){
          poolArray.push(pool.run({
            rowdata: {
              masterRecordID: maserDataRow.recordID,
              childRecordID: childRecordID
            },
            mode: 'LanguageRelationChild'
          }, options));
          if (cpuIndex === APR_CREDENTIALS.worker) {
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
      await writeExcel(csvData);
    }
  }
}

async function endProcess(){
  let randomName = APR_CREDENTIALS.targetPath + '/' + uuidv4() + '.xlsx'; // '110ec58a-a0f2-4ac4-8393-c866d813b8d1'
  fs.rename(APR_CREDENTIALS.checkin, randomName, function (err) {
    if (err) throw err;
    console.log('File Renamed.');
  });
}


async function writeExcel(jsonArray){
    //console.log("jsonArray", jsonArray);
    //console.log("jsonArray", jsonArray.length);
  
    var keys = [];
    for (var k in jsonArray[0]) keys.push(k);
    //keys.push("status", "recordID", "processdate");
  
    // Create a new workbook and worksheet
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet([],{ header: keys});
    
    
    jsonArray.forEach((row) => {
        XLSX.utils.sheet_add_json(worksheet, [row], { skipHeader: true, origin: -1 });
    });
    
  
    // Add the worksheet to the workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
    // Write the workbook to a file
    XLSX.writeFile(workbook, APR_CREDENTIALS.checkin);
  }
  

  main = async () => {
    plogger.info('####### Import Started at ' + new Date() + ' #########');
    console.log('####### Import Started at ' + new Date() + ' #########');

    if (fs.existsSync(APR_CREDENTIALS.checkin)) {
      //await readExcel();
      //await createRelation();
      await createLanguageRelationParent();
      await createLanguageRelationChild();
      //await endProcess();
    } else {
      await downloadCSVFromFtp();
      await JSONtoCheckInData();
      await readExcel();
      await createRelation();
      await createLanguageRelation();
      //await endProcess();
    }

    plogger.info('####### Import Ended at ' + new Date() + ' #########');
    console.log('####### Import Ended at ' + new Date() + ' #########');
    logger.info(new Date() + ': INFO : ideal waiting for next cron:');
    console.log(new Date() + ': INFO : ideal waiting for next cron:');
  };

  try {
    main();
  } catch (error) {
    logger.error(new Date() + ': System Error -- ' + error);
  }

