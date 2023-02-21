/**
 * 
 * Connect FTP
 * Download CSV file
 * Read CSV for Master/Child Records
 * Download binary file
 * Search for Record in a combination of KBObjectID and Title and Kittelberger ID
 * Search for Classification IDs
 * Create/Update Record
 * 
 */

const express = require("express");
var bodyParser = require("body-parser");
var fs = require("fs");

request = require("request");
const cron = require("node-cron");
//const fetch = require("node-fetch");
var path = require("path");
const mime = require("mime-types");
var FormData = require("form-data");
const winston = require("winston");
require('winston-daily-rotate-file');

let Client = require("ssh2-sftp-client");
const splitFile = require("split-file");
const csv = require("csvtojson");
const XLSX = require('xlsx');
const axios = require("axios").default;
const HttpsProxyAgent = require('https-proxy-agent');
const app = express();
const classificationlist = require("./bosch-classificationlist");

// Window System Path
//let imgFolderPath = "ftp-temp\\binnery\\";
let readJSONCron = true;
const APR_CREDENTIALS = JSON.parse(fs.readFileSync("aprimo-credentials.json"));

var fullProxyURL=APR_CREDENTIALS.proxyServerInfo.protocol+"://"+ APR_CREDENTIALS.proxyServerInfo.host +':'+APR_CREDENTIALS.proxyServerInfo.port;
if(APR_CREDENTIALS.proxyServerInfo.auth.username!="")
{
  fullProxyURL=APR_CREDENTIALS.proxyServerInfo.protocol+"://"+APR_CREDENTIALS.proxyServerInfo.auth.username +":"+ APR_CREDENTIALS.proxyServerInfo.auth.password+"@"+APR_CREDENTIALS.proxyServerInfo.host +':'+APR_CREDENTIALS.proxyServerInfo.port;
}


//FTP Server Binary Path
let imgFolderPath = APR_CREDENTIALS.imgFolderPath;

//FTP Config
const ftpConfig = JSON.parse(fs.readFileSync("ftp.json"));
app.use(express.json({
  limit: "150mb"
}));
app.use("/js", express.static(__dirname + "/js"));
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);


let ftpDirectory = APR_CREDENTIALS.targetPath;
fs.readdir(ftpDirectory, (err, files) => {
  if (err) throw err;

  for (const file of files) {    
      if(file.match(/.+(\.csv)$/)){
        /*
        fs.unlink(path.join(ftpDirectory, file), (err) => {
          if (err) throw err;
        });    
        */
      }
  }
});

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
const options = {
  from: new Date() - (168 * 60 * 60 * 1000),
  until: new Date(),
  limit: 100000,
  start: 0,
  order: 'desc',
  fields: ['message']
};

/**
 * Read the TLogger file.
 * @param {*} token 
 */
async function readTransactionLog(token) {
  let tloggerData = await tlogger.query(options, function (err, result) {
    if (err) {
      /* TODO: handle me */
      logger.error(new Date() + ': tlogger error -- ' + err);
      console.log('ERROR' + new Date() + ': tlogger error -- ', err);
      throw err;
    }else{
      //console.log("tloggerData:", result);
      readJSON(token, result);
    }
  });
}

/**
 * Generating Token
 */
getToken = async () => {
  const resultAssets = await axios.post(APR_CREDENTIALS.API_URL, JSON.stringify('{}'),{
      timeout: 30000,
      proxy: false,
      httpsAgent: new HttpsProxyAgent(fullProxyURL),
      headers: {
      "Content-Type": "application/json",
      "client-id": APR_CREDENTIALS.client_id,
      Authorization: `Basic ${APR_CREDENTIALS.Auth_Token}`,
      },
    }
  )
  .then(async (resp) => {
    return resp.data;
  })
  .catch(async (err) => {    
    logger.error(new Date() + ': getToken error -- ' + err);
    console.log('ERROR' + new Date() + ': getToken error -- ', err);
    var aprToken = await getToken();
    return aprToken;
  });
  return resultAssets;
};

/**
 * Download CSV files from the FTP
 */
downloadCSVFromFtp = async () => {
  var jsonData;
  const dst = APR_CREDENTIALS.targetPath;
  const src = APR_CREDENTIALS.sourcePath;
  let sftp = new Client();
  jsonData = await sftp.connect(ftpConfig)
    .then(async () => {
      const files = await sftp.list(src + '/.');
      for (var i = 0, len = files.length; i < len; i++) {
        if(files[i].name.match(/.+(\.csv)$/)){
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


async function JSONtoCheckInData() {
  console.log("Start");
  const csvInDir = fs
    .readdirSync(APR_CREDENTIALS.targetPath)
    .filter((file) => path.extname(file) === ".csv");
  
  let jsonArray = [];
  for (var i = 0, len = csvInDir.length; i < len; i++) {
    var file = csvInDir[i];  
    if (file) {
      const filePath = APR_CREDENTIALS.targetPath + "/" + file;
      const csvFileData = await csv({'delimiter':[';',',']}).fromFile(filePath);
      jsonArray.push(csvFileData);
    }
  } 

  await writeExcel(jsonArray);
};

async function writeExcel(jsonArray){
  //console.log("jsonArray", jsonArray);
  //console.log("jsonArray", jsonArray.length);
  //return;

  var keys = [];
  for (var k in jsonArray[0][0]) keys.push(k);
  //keys.push("status", "recordID", "processdate");

  // Create a new workbook and worksheet
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet([],{ header: keys});
  
  for (var i = 0, len = jsonArray.length; i < len; i++) {
    jsonArray[i].forEach((row) => {
      XLSX.utils.sheet_add_json(worksheet, [row], { skipHeader: true, origin: -1 });
    });
  }

  // Add the worksheet to the workbook
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
  // Write the workbook to a file
  XLSX.writeFile(workbook, APR_CREDENTIALS.checkin);
}


/**
 * Read the CSV file.
 * @param {*} token 
 */
async function readJSON(token, tloggerData) {

  plogger.info('####### Import Started at ' + new Date() + ' #########');
  console.log('####### Import Started at ' + new Date() + ' #########');
  const csvInDir = fs
    .readdirSync(APR_CREDENTIALS.targetPath)
    .filter((file) => path.extname(file) === ".csv");
  let jsonArray = [];
  plogger.info('Total files to Import ' + csvInDir.length);


  for (var i = 0, len = csvInDir.length; i < len; i++) {
    var file = csvInDir[i];
    //console.log(file);
    if (file) {
      //console.log(APR_CREDENTIALS.targetPath + "/" + file);
      const filePath = APR_CREDENTIALS.targetPath + "/" + file;
      const jsonFileArray = await csv({'delimiter':[';',',']}).fromFile(filePath);
      jsonArray = jsonFileArray;

      console.log(jsonArray);
      return false;


      plogger.info('Total rows ' + jsonArray.length + ' in csv ' + filePath);
      //console.log(jsonArray);
      const masterIDS = [...new Set(jsonArray.map((item) => item.OBJ_ID))];
      //console.log(masterIDS);
      const recordObj = {};
      recordObj.arr = new Array();
      for (let k = 0; k < masterIDS.length; k++) {
        const mID = masterIDS[k];
        
        const singleRecordObj = jsonArray.filter((val) => val.OBJ_ID === mID);

        let indexOfX = -1;
          for (let i = 0; i < singleRecordObj.length; i++) {
            if (singleRecordObj[i].MASTER_RECORD === "x") {
              indexOfX = i;
              break;
            }
          }

        let temp = singleRecordObj[0];
        singleRecordObj[0] = singleRecordObj[indexOfX];
        singleRecordObj[indexOfX] = temp;
        if (singleRecordObj.length > 0) {
          recordObj.arr.push(singleRecordObj);
        }
      }

  //console.log("tloggerData length:", tloggerData.length);
  let masterCount = 0;
  let masterErr = 0;
  let childCount = 0;

  const workers = [];

  for (let j = 0; j < recordObj.arr.length; j++) {
    const tt = recordObj.arr[j];
    for (let p = 0; p < tt.length; p++) {

        //console.log("Nested", tt[p].MASTER_RECORD);        
        if (tt[p]?.MASTER_RECORD !== undefined && tt[p].MASTER_RECORD === "x") {




        







          let KBObjectData = findObject(tloggerData, 'KBObjectID', tt[p].OBJ_ID);
          let KittelbergerData = findObject(KBObjectData, 'Kittelberger ID', tt[p].LV_ID);
          
          //console.log("Search KBObjectID:", tt[p].OBJ_ID);
          //console.log("Search KBObjectData:", KBObjectData);
          //console.log("Search Kittelberger ID:", tt[p].LV_ID);
          //console.log("Search KBObjectData:", KittelbergerData);
          //console.log("KittelbergerData length:", KittelbergerData.length);
          if(KittelbergerData.length === 0){
            //console.log("KBObjectID:", tt[p].OBJ_ID);
            console.log('####### KBObjectID ' + new Date() + tt[p].OBJ_ID);

/*            

            masterCount++;
            var aprToken = await getToken();
            if(aprToken?.accessToken !== undefined){
              let masterRecordID = await searchAsset(aprToken.accessToken, tt[p].BINARY_FILENAME, tt[p]);
              let childRecordID = [];
              for (let c = 0; c < tt.length; c++) {
                if (tt[c].MASTER_RECORD !== "x" && tt[p].OBJ_ID === tt[c].OBJ_ID) {
                  childCount++;
                  var aprToken = await getToken();
                  if(aprToken?.accessToken !== undefined){
                    childRecordID.push(await searchAsset(aprToken.accessToken, tt[c].BINARY_FILENAME, tt[c]));
                  }
                }
              }
              if (masterRecordID !== 0) {
                var aprToken = await getToken();
                if(aprToken?.accessToken !== undefined){
                  let recordLinksResult = await recordLinks(masterRecordID, childRecordID, aprToken.accessToken);
                  logger.info(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
                  console.log(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
                }
              } else {
                masterErr++;
                logger.error(new Date() + ': ERROR : Master Record Missing: ');
                console.log(new Date() + ': ERROR : Master Record Missing: ');
              }
            }
*/

              let sum = 0;
              for (let i = 0; i < 100000000; i++) {
                sum += i;
              }
              console.log('####### Break ' + new Date());
            break;
          }else{
            //console.log("Record Skipping: *****************");
          }








        }
    }
  }
  plogger.info('Total Master Records ' + masterCount );
  plogger.info('Total Child Records ' + childCount );
  plogger.info('Total Master Records Successfully Processed ' + (masterCount - masterErr));
  plogger.info('Total Master Records Not Processed ' + masterErr);



    }
  }


  plogger.info('####### Import Ended at ' + new Date() + ' #########');


  logger.info(new Date() + ': INFO : ideal waiting for next cron:');
  console.log(new Date() + ': INFO : ideal waiting for next cron:');
}

/**
 * Link Master and Child Records
 * @param {*} masterRecordID, childRecordID, token
 */
recordLinks = async (masterRecordID, childRecordID, token) => {
  let body = {
    "fields": {
      "addOrUpdate": [{
        "recordLinkConditions": null,
        "dataType": "RecordLink",
        "fieldName": "Belongs_to",
        "label": "Belongs_to",
        "id": 'adb8712c2fa64a82a20eaeef00a86614',
        "localizedValues": [{
          "links": null,
          "parents": null,
          "children": [],
          "languageId": "00000000000000000000000000000000",
          "readOnly": null,
          "modifiedOn": "2022-12-12T13:55:46.37Z"
        }],
        "inheritanceState": null,
        "inheritable": null
      }]
    }
  }

  for (let i = 0; i < childRecordID.length; i++) {
    body.fields.addOrUpdate[0].localizedValues[0].children.push({
      "recordId": childRecordID[i]
    });
  }

  const resultAssets = await axios.put(APR_CREDENTIALS.GetRecord_URL + '/' + masterRecordID,
      JSON.stringify(body), {
        proxy: false,
        httpsAgent: new HttpsProxyAgent(fullProxyURL),  
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "API-VERSION": APR_CREDENTIALS.Api_version,
          Authorization: `Bearer ${token}`,
        },
      }
    )
    .then((res) => {
      return true;
    })
    .catch((err) => {
      logger.error(new Date() + ': ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
      console.log(new Date() + ': ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
      return false;
    });
  return resultAssets;
};

/**
 * Search for The Records in a combination of KBObjectID and Title and Kittelberger ID
 * @param {*} File Name, CSV Row Data, token
 */
searchAsset = async (token, Asset_BINARY_FILENAME, recordsCollection) => {
  let filterFileName = Asset_BINARY_FILENAME.replace(/&/g, "%26");
  filterFileName = filterFileName.replace(/\+/g, "%2b");

  logger.info(new Date() + ': INFO : ###################################');
  logger.info(new Date() + ': INFO : Start Processing Row');
  let queryString = '';
  if(recordsCollection.LV_ID === ''){
    queryString = "'" + recordsCollection.OBJ_ID + "'";
  }else{
    queryString = "'" + recordsCollection.OBJ_ID + "'" + " and FieldName('Kittelberger ID') = '" + recordsCollection.LV_ID + "'";
  }
  

  logger.info(new Date() + ': INFO : SearchAsset URL: -- ' + APR_CREDENTIALS.SearchAsset + encodeURI(queryString));
  console.log(new Date() + ': INFO : SearchAsset URL: -- ', APR_CREDENTIALS.SearchAsset + encodeURI(queryString));
  console.log("fullProxyURL:: " + fullProxyURL);

  let APIResult = await axios
    .get(APR_CREDENTIALS.SearchAsset + encodeURI(queryString), 
    { 
      timeout: 30000,
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
      console.log(resp.data);
      let getFieldsResult = 0;
      if (itemsObj.totalCount === 0) {
        logger.info(new Date() + ': INFO : Records Creating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        console.log(new Date() + ': INFO : Records Creating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);

        getFieldsResult = await getFields("null", token, recordsCollection);
      } else if (itemsObj.totalCount === 1) {
        logger.info(new Date() + ': INFO : Records Updating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        console.log(new Date() + ': INFO : Records Updating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        getFieldsResult = await getFields(itemsObj.items[0].id, token, recordsCollection);
      }
      return getFieldsResult;
    })
    .catch(async (err) => {
      logger.error(new Date() + ': ERROR : Search Asset API -- ' + JSON.stringify(err));
      console.log(new Date() + ': ERROR : Search Asset API -- ' + JSON.stringify(err));
      return 0;
    });

    logger.info(new Date() + ': INFO : End Processing Row');    
    logger.info(new Date() + ': INFO : ###################################');
    logger.info(new Date() + ' ');    
  
  return APIResult;
};

/**
 * Search for Classification ID
 * @param {*} Class Name, CSV Row Data, token
 */
searchClassification = async (ClassID, token, data) => {
  let filterClass = ClassID.replace(/&/g, "%26");
  filterClass = filterClass.replace(/\+/g, "%2b");

  let resultID = await axios
    .get(APR_CREDENTIALS.GetClassification + filterClass, {
      //proxy: APR_CREDENTIALS.proxyServerInfo,
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
      console.log("resp.data.id:", resp.data.id);
      if (resp.data.id === null) {
        console.log(new Date() + ": WARNING : Classification Missing -- ", APR_CREDENTIALS.GetClassification + filterClass);
        clogger.warn(new Date() + ': WARNING : Classification Missing -- ' + APR_CREDENTIALS.GetClassification + filterClass);
        return 'null';
      } else {
        classificationlist[ClassID] = resp.data.id;
        await writeClassificationlist();
        return resp.data.id;
      }
    })
    .catch(async (err) => {
      console.log(new Date() + ": WARNING : Classification Missing -- ", JSON.stringify(err));
      clogger.warn(new Date() + ': WARNING : Classification Missing URL -- ' + APR_CREDENTIALS.GetClassification + filterClass);
      clogger.warn(new Date() + ': WARNING : is ' + JSON.stringify(err));
      return 'null';
    });
  return resultID;
};

/**
 * 
 * Write Classification in local DB for reduce API Call
 */
writeClassificationlist = async () => {
  fs.writeFile("bosch-classificationlist.json", JSON.stringify(classificationlist), err => {
    // Checking for errors
    if (err) throw err;
    //console.log("04 classificationlist Updated"); // Success
  });
};

/**
 * Check File Size
 * @param {*} File Name
 */
getFilesizeInMegabytes = async (filename) => {
  var stats = fs.statSync(filename);
  var fileSizeInBytes = stats.size;
  var fileSizeInMegabytes = fileSizeInBytes / (1024 * 1024);
  console.log("fileSizeInMegabytes:", fileSizeInMegabytes);
  return fileSizeInMegabytes;
};

/**
 * 
 * Check fields Create/Update. 
 * @param {*} assetID, token, Row Data
 */  
getFields = async (assetID, token, recordsCollection) => {
  let findAssetID;
  let existImgId;
  let filename;
  let APIResult = 0;

  if (assetID === "null") {
    //Create New
    findAssetID = APR_CREDENTIALS.tempAssetID;
    filename = recordsCollection.BINARY_FILENAME;
    existImgId = "null";

    const ImageToken = await uploadAsset(token, filename);    
    console.log(new Date() + ": INFO : Create Meta:");
    logger.info(new Date() + ': INFO : Create Meta:');
    try {
      APIResult = await createMeta(assetID, recordsCollection, ImageToken, token);      
    } catch (error) {
      console.log(new Date() + ": Error : Create Meta: "+ error);
      logger.info(new Date() + ': Error : Create Meta: '+ error);        
    }
  } else {
    try {
      APIResult = await createMeta(assetID, recordsCollection, 'null', token);  
    } catch (error) {
      console.log(new Date() + ": Error : Create Meta: "+ error);
      logger.info(new Date() + ': Error : Create Meta: '+ error);
    }
  }
  return APIResult;
};

/**
 * 
 * Find fields IDs for updating records. 
 * @param {*} token
 */  
getFieldIDs = async (token) => {
  let getFieldsResult = await axios
    .get(APR_CREDENTIALS.GetRecord_URL + APR_CREDENTIALS.tempAssetID + '/fields', {
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
        return resp.data.items;
      } else {
        logger.error(new Date() + ': ERROR : tempAssetID Missing --');
        console.log(new Date() + ': ERROR : tempAssetID Missing --');
        return null;
      }
    })
    .catch(async (err) => {
      logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err));
      console.log(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err));
      return null;
    });
  return getFieldsResult;
};

/**
 * 
 * createMeta for updating records. 
 * @param {*} assetID, Row data, ImgToken, token
 */  
createMeta = async (assetID, data, ImgToken, token) => {

  let APIResult = false;
  let updateObj = {
    tag: "<xml>test tag</xml>",
    classifications: {
      addOrUpdate: []
    },
    fields: {
      addOrUpdate: []
    },
  };
  let tempAssetObj = await getFieldIDs(token);

  if (ImgToken !== "null") {
    updateObj.files = {
      master: ImgToken,
      addOrUpdate: [{
        versions: {
          addOrUpdate: [{
            id: ImgToken,
            filename: data["BINARY_FILENAME"],
            tag: "<xml>Uploaded by Script</xml>",
            versionLabel: "Uploaded by Script",
            comment: "Uploaded by Script",
          }, ],
        },
      }, ],
    };
  }

  let ClassObj = [];
  for (var key in data) {
    let ClassID = [];
    let tmpKey = data[key];
    let optionVal = "False";
    let ObjectID = '';

    if (typeof tmpKey === 'string') {
      tmpKey = tmpKey.replace(/&/g, "%26");
      tmpKey = tmpKey.replace(/\+/g, "%2b");
    }

    // skip loop if the property is from prototype
    if (!data.hasOwnProperty(key)) continue;

    if ((data[key] === null || data[key] === '') && key === 'INIT_NAME'){
      ObjectID = findObject(tempAssetObj, 'fieldName', 'AssetOwner');
      updateObj.fields.addOrUpdate.push({
        "id": ObjectID[0].id,
        "localizedValues": [{
          "values": [APR_CREDENTIALS.defaultAssetOwner],
          "languageId": "00000000000000000000000000000000"
        }]
      });
      continue;
    }

    if (data[key] === null || data[key] === '') continue;

    switch (key) {
      case 'OBJ_ID':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'KBObjectID');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        break;
      case 'NAME':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Title');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'OTYPE_ID':
        // code block
        break;
      case 'OTYPE_NAME':
        APIResult = await searchClassificationName(data[key], token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        }

        ObjectID = findObject(tempAssetObj, 'fieldName', 'Kittelberger Object Type');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "values": ClassID,
            "languageId": "00000000000000000000000000000000"
          }]
        });

        // code block
        break;
      case 'SYSTEM_STATUS':
        APIResult = await searchClassificationName(data[key], token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        }

        ObjectID = findObject(tempAssetObj, 'fieldName', 'SystemStatus');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "values": ClassID,
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'LV_ID':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Kittelberger ID');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'MASTER_RECORD':
        /*
        ObjectID = findObject(tempAssetObj, 'fieldName', 'BI_Master');
        if(data[key] === 'x'){
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
                "values": ['c0cbb041f69b4c75aebfaeef0090663e'],
                "languageId": "00000000000000000000000000000000"
            }]
          });  
        }*/
        // code block
        break;
      case 'LTYPE_ID':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'LTYPE ID');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'LTYPE_NAME':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'LTYPE Name');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'ORIGINAL_FILENAME':
        // code block
        break;
      case 'BINARY_FILENAME':
        // code block
        break;
      case 'CATEGORY_TREE_NAMES':
        if (typeof tmpKey === 'string') {        
          tmpKey = tmpKey.replace(/\|\|/g, "/");
        
        var str_array = tmpKey.split('\\\\');
        for (var i = 0; i < str_array.length; i++) {
          // Trim the excess whitespace.
          str_array[i] = str_array[i].replace(/^\s*/, "").replace(/\s*$/, "");
          // Add additional code here, such as:
          if (classificationlist.hasOwnProperty('/MPE Migration/' + str_array[i]) && classificationlist['/MPE Migration/' + str_array[i]] !== undefined) {
            ClassID.push(classificationlist['/MPE Migration/' + str_array[i]]);
          } else {
            let APIResult = await searchClassification('/MPE Migration/' + str_array[i], token, data)
            if (APIResult !== 'null') {
              ClassID.push(APIResult);
            }
          }
        }
      }
        /*
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Kittelberger Category Tree');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
              "value": ClassID,
              "languageId": "00000000000000000000000000000000"
          }]
        }); */
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Kittelberger Category Tree');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'CATEGORY_TREE_IDS':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Kittelberger Category Tree Ids');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'CSORELEASE_MASTER':
        if (data[key] === 'x') {
          optionVal = "True"
        }
        ObjectID = findObject(tempAssetObj, 'fieldName', 'BI_Master');
        APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], optionVal, token, key)
        if (APIResult !== 'null') {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": [APIResult],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }
        // code block
        break;
      case 'BRAND':
        APIResult = await searchClassificationName(tmpKey, token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        }

        ObjectID = findObject(tempAssetObj, 'fieldName', 'Brand');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "values": ClassID,
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'INIT_DATE':
        // code block
        break;
      case 'DOUBLE_WIDTH':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'DoubleWidth');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'HD_OBJECT':
        if (data[key] === 'x') {
          optionVal = "True"
        }

        ObjectID = findObject(tempAssetObj, 'fieldName', 'HD Object');
        APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], optionVal, token, key)
        if (APIResult !== 'null') {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": [APIResult],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }
        // code block
        break;
      case 'ILABEL':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'ILabel');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'IMG_TYPE':
        APIResult = await searchClassificationName(tmpKey, token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        }

        ObjectID = findObject(tempAssetObj, 'fieldName', 'AssetType');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "values": ClassID,
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'KEYWORDS':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Keywords');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "values": [data[key]],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'MISSING_TTNR':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Missing_TTNR');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'FILENAME':
        // code block
        break;
      case 'SYMBOLIMG_DESCRIPTION':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Short Describtion');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'DESCRIPTION':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'SmartDescription');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });

        // code block
        break;
      case 'AGENCY':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'PostProduction');
        APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key], token, key)
        if (APIResult !== 'null') {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": [APIResult],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }

        // code block
        break;
      case 'STATUS':
        APIResult = await searchClassificationName(tmpKey, token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        }

        ObjectID = findObject(tempAssetObj, 'fieldName', 'Status');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "values": ClassID,
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'INIT_NAME':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Init Name');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        var firstName = data[key].substring(0, data[key].lastIndexOf(" ") + 1);
        var lastName = data[key].substring(data[key].lastIndexOf(" ") + 1, data[key].length);

        //console.log('INIT_NAME **************', firstName);
        //console.log('INIT_NAME **************', lastName);
        APIResult = await searchUser(firstName, lastName, token);
        if(APIResult !== '0'){
          ObjectID = findObject(tempAssetObj, 'fieldName', 'AssetOwner');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": [APIResult],
              "languageId": "00000000000000000000000000000000"
            }]
          });          
        } else {
          ObjectID = findObject(tempAssetObj, 'fieldName', 'AssetOwner');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": [APR_CREDENTIALS.defaultAssetOwner],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }


        // code block
        break;
      case 'ORIG_BE_ID':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Original BE ID');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'AC_MAIN_USAGE':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'IntendedUsage');
        APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key], token, key)
        if (APIResult !== 'null') {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": [APIResult],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }
        // code block
        break;
      case 'LINKED_PRODUCTS':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'ReferencedProductsinPIM');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'LAUNCH_DATE':
        let LAUNCH_DATE_VAR = new Date(data[key]);
        ObjectID = findObject(tempAssetObj, 'fieldName', 'LaunchDate');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": LAUNCH_DATE_VAR,
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'CLIPLISTER_LINKS':
        // code block
        break;
      case 'COLOR_SPACE':
        // code block
        ObjectID = findObject(tempAssetObj, 'fieldName', 'ColorSpace');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });        
        break;
  
      default:
        // code block
    }


    if (ClassID.length > 0) {
      for (let i = 0; i < ClassID.length; i++) {
        if (ClassID[i].length > 0) {
          if (ClassID[i] !== 'null') {
            ClassObj.push(ClassID[i]);
          }
        }
      }
    }
  }

  for (let c = 0; c < ClassObj.length; c++) {
    updateObj.classifications.addOrUpdate.push({
      "id": ClassObj[c],
      "sortIndex": c
    });
  }

  console.log(new Date() + ": INFO : Update JSON:", JSON.stringify(updateObj));
  logger.info(new Date() + ': INFO : Update JSON:' + JSON.stringify(updateObj));


  if (assetID === "null") {
    let reqCreatRequest = await axios
      .post(APR_CREDENTIALS.CreateRecord, JSON.stringify(updateObj), {        
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
        if (resp.data.id !== undefined) {
          logger.info(new Date() + ': INFO : Record ID: ' + resp.data.id);
          console.log(new Date() + ': INFO : Record ID: ' + resp.data.id);

          tlogger.info({
            'filename': data['BINARY_FILENAME'],
            'title': data['NAME'],
            'filepath': data['BINARY_FILENAME'],
            'recordID': resp.data.id,
            'KBObjectID': data['OBJ_ID'],
            'OTYPEID': data['OTYPE_ID'],
            'LTYPEID': data['LTYPE_ID'],
            'Kittelberger ID': data['LV_ID'],
            'token': ImgToken
          });

          return resp.data.id;
        } else {
          logger.error(new Date() + ': ERROR : CREATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
          console.log(new Date() + ': ERROR : CREATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
          logger.error(new Date() + ': ERROR : CREATE RECORD API -- ' + JSON.stringify(resp));
          console.log(new Date() + ': ERROR : CREATE RECORD API -- ' + JSON.stringify(resp));
          return '0';
        }
      })
      .catch((err) => {
        logger.error(new Date() + ': ERROR : CREATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
        console.log(new Date() + ': ERROR : CREATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
        logger.error(new Date() + ': ERROR : CREATE RECORD API -- ' + JSON.stringify(err));
        console.log(new Date() + ': ERROR : CREATE RECORD API -- ' + JSON.stringify(err));
        return '0';
      });
    return reqCreatRequest;
  } else {

    let reqCreatRequest = await axios
      .put(APR_CREDENTIALS.GetRecord_URL + assetID, JSON.stringify(updateObj), {
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
        logger.info(new Date() + ': INFO : Record Updated: ' + assetID);
        console.log(new Date() + ': INFO : Record Updated: ' + assetID);

        tlogger.info({
          'filename': data['BINARY_FILENAME'],
          'title': data['NAME'],
          'filepath': data['BINARY_FILENAME'],
          'recordID': assetID,
          'KBObjectID': data['OBJ_ID'],
          'OTYPEID': data['OTYPE_ID'],
          'LTYPEID': data['LTYPE_ID'],
          'Kittelberger ID': data['LV_ID'],
          'token': 'meta updated only'
        });        //ImgToken
    
        //console.log(': Update Record ID: ');
        return assetID;
      })
      .catch((err) => {
        logger.error(new Date() + ': ERROR : UPDATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID' + data.OBJ_ID);
        console.log(new Date() + ': ERROR : UPDATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID' + data.OBJ_ID);
        logger.error(new Date() + ': ERROR : UPDATE RECORD API -- ' + JSON.stringify(err));
        console.log(new Date() + ': ERROR : UPDATE RECORD API -- ' + JSON.stringify(err));
        return '0';
      });
    return reqCreatRequest;
  }

};

/**
 * 
 * Search for User Data
 * @param {*} firstName, lastName, token
 */ 
searchUser = async (firstName, lastName, token) => {
  let body = {
    "and":[
       {
          "contains":{
            "fieldName": "firstName",
            "fieldValue": firstName.trim()
          }
       },
       {
          "contains":{
            "fieldName": "lastName",
            "fieldValue": lastName.trim()
          }
       }
    ]
 };


  logger.error(new Date() + ': INFO : Search USER ID: ' + JSON.stringify(body));
  console.log(new Date() + ': INFO : Search USER ID: ', JSON.stringify(body));
  logger.error(new Date() + ': INFO : Search USER URL: ' + APR_CREDENTIALS.SearchUser);
  console.log(new Date() + ': INFO : Search USER URL: ', APR_CREDENTIALS.SearchUser);
  let reqCreatRequest = await axios
      .post(APR_CREDENTIALS.SearchUser, JSON.stringify(body), {
        proxy: false,
        httpsAgent: new HttpsProxyAgent(fullProxyURL),
        headers: {
            Accept: "*/*",
            "Content-Type": "application/json",
            "API-VERSION": APR_CREDENTIALS.Api_version,
            Authorization: `Bearer ${token}`,
            "X-Access-Token": token
          },
      })
      .then(async (resp) => {        
        if (resp.data['_total'] !== 0) {
          logger.error(new Date() + ': INFO : USER ID: ', resp.data['_embedded'].user[0].adamUserId);
          console.log(new Date() + ': INFO : USER ID: ', resp.data['_embedded'].user[0].adamUserId);
          return resp.data['_embedded'].user[0].adamUserId;
        } else {
          logger.error(new Date() + ': ERROR : USER NOT FOUND -- First Name: ' + firstName + ' Last Name: ' + lastName);
          console.log(new Date() + ': ERROR : USER NOT FOUND -- First Name: ' + firstName + ' Last Name: ' + lastName);
          return '0';
        }
      })
      .catch((err) => {
        logger.error(new Date() + ': ERROR : USER SEARCH API -- First Name: ' + firstName + ' Last Name: ' + lastName);
        console.log(new Date() + ': ERROR : USER SEARCH API -- First Name: ' + firstName + ' Last Name: ' + lastName);
        logger.error(new Date() + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err));
        console.log(new Date() + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err));
        return '0';
      });
    return reqCreatRequest;
};

/**
 * 
 * Get Template Field for definition
 * @param {*} fieldURL, fieldValue, token, keyValue
 */ 
getfielddefinitionID = async (fieldURL, fieldValue, token, keyValue) => {
  //let filterClass = fieldURL.replace(/&/g, "%26");
  //filterClass = filterClass.replace(/\+/g, "%2b");
  //console.log('filterClass: ', filterClass);
  let resultID = await axios
    .get(encodeURI(fieldURL),      
      {
      proxy: false,
      httpsAgent: new HttpsProxyAgent(fullProxyURL), 
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        "API-VERSION": APR_CREDENTIALS.Api_version,
        Authorization: `Bearer ${token}`,
      },
    }
    )
    .then(async (resp) => {
      //console.log("resp.data:--------", resp.data);
      ObjectID = findObject(resp.data.items, 'name', fieldValue);
      //console.log("ObjectID:--------", ObjectID);
      if (ObjectID.length > 0) {
        //console.log(new Date() + ': ObjectID.id -- ' + ObjectID[0].id);
        return ObjectID[0].id;
      } else {
        console.log(new Date() + ': ERROR : Field Definition -- ' + fieldURL);
        logger.error(new Date() + ': ERROR : Field Definition -- ' + fieldURL);
        console.log(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);
        logger.error(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);

        return 'null';
      }
    })
    .catch(async (err) => {
      console.log(new Date() + ': ERROR : Field Definition API -- ' + fieldURL);
      console.log(new Date() + ": ERROR : Field Definition API -- ", JSON.stringify(err));
      logger.error(new Date() + ': ERROR : Field Definition API -- ' + fieldURL);
      logger.error(new Date() + ': ERROR : is ' + JSON.stringify(err));
      console.log(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);
      logger.error(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);

      return 'null';
    });
  return resultID;
};

/**
 * 
 * Search for Classificate Name
 * @param {*} ClassID, token, data
 */ 
searchClassificationName = async (ClassID, token, data) => {
  //let filterClass = ClassID.replace(/&/g, "%26");
  //filterClass = filterClass.replace(/\+/g, "%2b");
  //console.log("searchClassificationName URL: ", APR_CREDENTIALS.GetClassificationByName + "'" + filterClass + "'");
  let resultID = await axios
    .get(APR_CREDENTIALS.GetClassificationByName + "'" + encodeURI(ClassID) + "'", {
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
      if (itemsObj.totalCount === 1) {
        console.log("Field Value: ", itemsObj.items[0].id);
        return itemsObj.items[0].id;
      } else {
        logger.error(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        return 'null';
      }
    })
    .catch(async (err) => {
      logger.error(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
      console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
      logger.warn(new Date() + ': ERROR : is ' + JSON.stringify(err));
      return 'null';
    });
  return resultID;
};

/**
 * Upload file into Aprimo
 * @param {*} token, filename 
 */
async function uploadAsset(token, filename) {
  let BINARY_FILENAME = filename
  let remotePath = APR_CREDENTIALS.sourcePath + '/binary/' + filename;
  filename = imgFolderPath + filename;
  
  console.log("File Downloading Started:: ", remotePath, " :: ", filename);
  let sftp = new Client();
  await sftp.connect(ftpConfig)
    .then(async () => {
      
      await sftp.fastGet(remotePath, filename);

      console.log("File Downloading Ended:: ", remotePath, " :: ", filename);
    }).catch(e => {
      logger.error(new Date() + ': ERROR : in the FTP Connection -- ' + e);
      console.log(new Date() + ': ERROR : in the FTP Connection -- ' + e);
    });
    

    if (fs.existsSync(filename) && BINARY_FILENAME !== '') {
      let varFileSize = await getFilesizeInMegabytes(filename);
      let varFileSizeByte = varFileSize * (1024 * 1024);
      let getMimeType = mime.lookup(filename);
      //console.log("varFileSize:", varFileSize);
      //logger.info(new Date() + ": getMimeType: " + getMimeType);
      //logger.info(new Date() + ': FileSize: ' + varFileSize);
      let APIResult = null;
      if (varFileSize > 1) {
        let SegmentURI = await getSegmentURL(filename, token);
        console.log("SegmentURI: ", SegmentURI);
        APIResult = await splitFile
          .splitFileBySize(filename, 10000000)
          .then(async (names) => {
            for (let start = 0; start < names.length; start++) {
              console.log("splitFileBySize: ", start, names[start]);
              const aprToken = await getToken();
              if(aprToken?.accessToken !== undefined){
                token = aprToken.accessToken;
                await uploadSegment(
                  SegmentURI + "?index=" + start,
                  names[start],
                  token
                );
              }
            }
            
            const ImgToken = await commitSegment(SegmentURI, filename, names.length, token);
            //logger.info(new Date() + ": INFO : commitSegment: " + ImgToken);
            return ImgToken;
          })
          .catch((err) => {
            logger.error(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err));
            console.log(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err));
            return null;
            //console.log('Error: ', err);
          });
        return APIResult;
      } else {
        //console.log("fileSize is < 20 MB:");
        //logger.info(new Date() + ": fileSize is < 20 MB: ");
        let form = new FormData();
        form.append("file", fs.createReadStream(filename), {
          contentType: getMimeType,
          filename: BINARY_FILENAME,
        });
        console.log("varFileSizeByte: ", varFileSizeByte);
        let reqUploadImg = await axios
          .post(APR_CREDENTIALS.Upload_URL, form, {
            proxy: false,
            httpsAgent: new HttpsProxyAgent(fullProxyURL),
            headers: {
              Accept: "*/*",
              "Content-Type": "multipart/form-data",
              "API-VERSION": APR_CREDENTIALS.Api_version,
              Authorization: `Bearer ${token}`,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          })
          .then(async (resp) => {
            let ImgToken = resp.data.token;
            console.log("ImgToken: ", ImgToken);
            // logger.info(new Date() + ": ImgToken: " + ImgToken);
            //APIResult = await getFields("null", token, ImgToken);
            return ImgToken;
            //await createAsset(ImgToken, data, token);
          })
          .catch((err) => {
            logger.error(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err));
            console.log(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err));
            return null;
          });

        return reqUploadImg;
      }



    }else{
      logger.error(new Date() + ': ERROR : File Not Found in the FTP -- ' + filename);
      console.log(new Date() + ': ERROR : File Not Found in the FTP -- ' + filename);
    }
    sftp.end();

}

/***
 * Get Segment URL for Big file upload in chunks
 */
getSegmentURL = async (filename, token) => {
  let body = {
    filename: path.basename(filename)
  };
  console.log(
    "APR_CREDENTIALS.Upload_Segments_URL",
    APR_CREDENTIALS.Upload_Segments_URL
  );
  //logger.info(new Date() + ": Upload_Segments_URL: " + APR_CREDENTIALS.Upload_Segments_URL);
  //logger.info(new Date() + ": Body: " + JSON.stringify(body));

  const resultSegmentURI = await axios
    .post(APR_CREDENTIALS.Upload_Segments_URL, JSON.stringify(body), {
      proxy: false,
      httpsAgent: new HttpsProxyAgent(fullProxyURL), 
      headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "API-VERSION": APR_CREDENTIALS.Api_version,
          Authorization: `Bearer ${token}`,
        },
    })
    .then((res) => {
      return res.data.uri;
    })
    .catch((err) => {
      logger.error(new Date() + ': ERROR : getSegment -- ' + JSON.stringify(err));
      console.log(new Date() + ': ERROR : getSegment -- ' + JSON.stringify(err));
    });
  return resultSegmentURI;
};


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
 * uploadSegment
 */
uploadSegment = async (SegmentURI, chunkFileName, token) => {
  let form = new FormData();
  form.append("file", fs.createReadStream(chunkFileName), {
    contentType: "image/png",
    filename: chunkFileName,
  });
  let reqUploadImg = await axios
    .post(SegmentURI, form, {
      proxy: false,
      httpsAgent: new HttpsProxyAgent(fullProxyURL), 
      headers: {
          Accept: "*/*",
          "Content-Type": "multipart/form-data",
          "API-VERSION": APR_CREDENTIALS.Api_version,
          Authorization: `Bearer ${token}`,
        },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    })
    .then(async (resp) => {
      console.log("Segment Upload Done for:", chunkFileName);
    })
    .catch((err) => {
      logger.error(new Date() + ': ERROR : uploadSegment -- ' + JSON.stringify(err));
      console.log(new Date() + ': ERROR : uploadSegment -- ' + JSON.stringify(err));
    });
};

/**
 * commitSegment
 */
commitSegment = async (SegmentURI, filename, segmentcount, token) => {
  //logger.info(new Date() + ": commitSegment: ");
  let APIResult = false;
  let body = {
    filename: path.basename(filename),
    segmentcount: segmentcount,
  };
  console.log("Commit body: ", body);
  let reqUploadImg = await axios
    .post(SegmentURI + '/commit', body, {
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
      let ImgToken = resp.data.token;
      console.log("Image Token===", ImgToken);
      //APIResult = await getFields('null', data, token, ImgToken);
      return ImgToken;
    })
    .catch((err) => {
      logger.error(new Date() + ': ERROR : commitSegment -- ' + JSON.stringify(err));
      console.log(new Date() + ': ERROR : commitSegment -- ' + JSON.stringify(err));

      return false;
    });
  return reqUploadImg;
};

/**
 * Entry point
 */
main = async () => {

  if (fs.existsSync(APR_CREDENTIALS.checkin)) {
    console.log("0001");
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    let data = [];
    const sheets = file.SheetNames;
    for (let i = 0; i < sheets.length; i++) {
        const temp = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]]);
        let index = 0;
        for (const res of temp) {
          if(res?.status !== 'checkin'){
            data.push(res);
            break; 
          }
          index++;
        }

        //console.log("index: " + index);
        //console.log("temp.length: " + temp.length);
        if(index < temp.length){
          for (let i = 0; i < APR_CREDENTIALS.worker; i++) {
            //console.log("I am IN: ");
            //const worker = new Worker(__filename, { workerData: { value: 0 } });
          }
        }

        console.log("checkin index: ", index);
        temp[index].status = 'checkin';
        temp[index].recordID = '';
        temp[index].processdate = '';
        await writeExcel([temp]);
    }
    //console.log("data:", data.length);
  } else {
    //await downloadCSVFromFtp();
    await JSONtoCheckInData();
  }
  //process.exit(0);

  // Create a new workbook and worksheet


/*
  var aprToken = await getToken();
  if(aprToken?.accessToken !== undefined){
    var getFile = await downloadCSVFromFtp(aprToken.accessToken);
  }
  */
};

module.exports = async (rowdata) => {
  console.log("Data:", rowdata);
  var aprToken = await getToken();
  if(rowdata.mode === 'createRecords'){
    let RecordID = await searchAsset(aprToken.accessToken, rowdata.rowdata.BINARY_FILENAME, rowdata.rowdata);
    rowdata.recordID = RecordID;
    return Promise.resolve(rowdata);
  } else if(rowdata.mode === 'linkRecords'){

    console.log(new Date() + ': INFO : rowdata.rowdata.masterRecordID: ' + rowdata.rowdata.masterRecordID);
    console.log(new Date() + ': INFO : rowdata.rowdata.childRecordID: ' + rowdata.rowdata.childRecordID);

    let recordLinksResult = await recordLinks(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID, aprToken.accessToken);
    logger.info(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    console.log(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    return Promise.resolve(recordLinksResult);
  }
}

/*
try {
  main();
} catch (error) {
  logger.error(new Date() + ': System Error -- ' + error);
}  
*/










/**
 * Cron to call Main
 * @param {*} token, filename 
 */
var task = cron.schedule(APR_CREDENTIALS.cronIntv, async () => {  
  try {
    //await main();
  } catch (error) {
    logger.error(new Date() + ': System Error -- ' + error);
  }
});
task.start();

/*

app.set("port", process.env.PORT || 3012);
app.listen(app.get("port"), function () {
  console.log("server started on port" + app.get("port"));
});

*/