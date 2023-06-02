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
var fs = require("fs");
request = require("request");
var path = require("path");
const mime = require("mime-types");
var FormData = require("form-data");
const winston = require("winston");
require('winston-daily-rotate-file');

let Client = require("ssh2-sftp-client");
const splitFile = require("split-file");
const axios = require("axios").default;
const HttpsProxyAgent = require('https-proxy-agent');
const { JsonDB, Config } = require('node-json-db');
const db = new JsonDB(new Config("fieldIDs", true, true, '/'));
const dbtoken = new JsonDB(new Config("apitoken", true, true, '/'));
const kMap = new JsonDB(new Config("keymapping", true, true, '/'));
const langMap = new JsonDB(new Config("languagemapping", true, true, '/'));

const maxRetries = 3;
const retryDelay = 1000;
let retries = 0;
let logRowInfo = '';
let dataFlag = true;

// Window System Path
//let imgFolderPath = "ftp-temp\\binnery\\";
let API_TOKEN = {
  timeStamp: new Date().getTime() - 480000,
  accessToken: ''
};

const APR_CREDENTIALS = JSON.parse(fs.readFileSync("aprimo-credentials.json"));
const oTypes = JSON.parse(fs.readFileSync("otypes-mapping.json"));
//console.log("oTypes", oTypes);
//let AssetTypeValue = findObject(oTypes, 'OTYPE_ID', 16);
//console.log("AssetTypeValue", AssetTypeValue);
//return false;

var fullProxyURL=APR_CREDENTIALS.proxyServerInfo.protocol+"://"+ APR_CREDENTIALS.proxyServerInfo.host +':'+APR_CREDENTIALS.proxyServerInfo.port;
if(APR_CREDENTIALS.proxyServerInfo.auth.username!="")
{
  fullProxyURL=APR_CREDENTIALS.proxyServerInfo.protocol+"://"+APR_CREDENTIALS.proxyServerInfo.auth.username +":"+ APR_CREDENTIALS.proxyServerInfo.auth.password+"@"+APR_CREDENTIALS.proxyServerInfo.host +':'+APR_CREDENTIALS.proxyServerInfo.port;
}


//FTP Server Binary Path
let imgFolderPath = APR_CREDENTIALS.imgFolderPath;

//FTP Config
const ftpConfig = JSON.parse(fs.readFileSync("ftp.json"));

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
var appClassification = new winston.transports.DailyRotateFile({
  level: 'info',
  filename: './logs/bosch-app-classification-error.log',
  createSymlink: true,
  symlinkName: 'bosch-app-classification-error',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});
var appCombined = new winston.transports.DailyRotateFile({
  name: 'info',
  //filename: './logs/bosch-app-combined-%DATE%.log',
  filename: './logs/bosch-app-combined.log',
  createSymlink: true,
  symlinkName: 'bosch-app-combined.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});

var tokensLogs = new winston.transports.DailyRotateFile({
  filename: './logs/bosch-app-uploaded-file-tokens.log',
  createSymlink: true,
  symlinkName: 'bosch-app-uploaded-file-tokens.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m',
  json: true
});

const logger = winston.createLogger({
  level: 'info',
  transports: [appError, appCombined]
});
const clogger = winston.createLogger({
  level: 'info',
  transports: [appClassification]
});
const tlogger = winston.createLogger({
  level: 'info',
  transports: [tokensLogs]
});

/**
 * Link Master and Child Records
 * @param {*} masterRecordID, childRecordID
 */
recordLinks = async (masterRecordID, childRecordID) => {
  
  let token = await getObjectDefault("/token", "null");

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

  logger.info(new Date() + logRowInfo + ': Start recordLinks API: '+ masterRecordID);
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
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ' LINKING ERROR: recordLinks API -- ' + JSON.stringify(err.response.data));
        //console.log(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ' LINKING ERROR: recordLinks API -- ' + JSON.stringify(err));
        //console.log(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
      }  
      return false;
    });
    
    logger.info(new Date() + logRowInfo + ': End recordLinks API: '+ masterRecordID);
  return resultAssets;
};



/**
 * Search for The Records in a combination of KBObjectID and Title and Kittelberger ID
 * @param {*} File Name, CSV Row Data
 */
searchAsset = async (recordsCollection) => {
  ///let filterFileName = Asset_BINARY_FILENAME.replace(/&/g, "%26");
  //filterFileName = filterFileName.replace(/\+/g, "%2b");
  
  let token = await getObjectDefault("/token", "null");

  logger.info(new Date() + logRowInfo + ' INFO : ###################################');
  logger.info(new Date() + logRowInfo + ' INFO : Start Processing Row');
  let queryString = '';
  if(recordsCollection.LV_ID === ''){
    queryString = "'" + recordsCollection.OBJ_ID + "'";
  }else{
    queryString = "'" + recordsCollection.OBJ_ID + "'" + " and FieldName('Kittelberger ID') = '" + recordsCollection.LV_ID + "'";
  }
  

  logger.info(new Date() + logRowInfo + ' INFO : SearchAsset URL: -- ' + APR_CREDENTIALS.SearchAsset + encodeURI(queryString));
  //console.log(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID);
  //console.log(new Date() +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' INFO : SearchAsset URL: -- ', APR_CREDENTIALS.SearchAsset + encodeURI(queryString));
  //console.log("fullProxyURL:: " + fullProxyURL);

  let APIResult = await axios
    .get(APR_CREDENTIALS.SearchAsset + encodeURI(queryString), 
    { 
      timeout: 60000,
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
      //console.log(resp.data);
      let getFieldsResult = 0;
      if (itemsObj.totalCount === 0) {
        logger.info(new Date() + logRowInfo + ' INFO : Records Creating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        //console.log(new Date() +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' INFO : Records Creating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);

        getFieldsResult = await getFields("null", recordsCollection);
      } else if (itemsObj.totalCount === 1) {
        logger.info(new Date() + logRowInfo  + ' INFO : Records Updating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        //console.log(new Date() +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  +  ' INFO : Records Updating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        getFieldsResult = await getFields(itemsObj.items[0].id, recordsCollection);
      }else{
        logger.info(new Date() + logRowInfo  + ' ERROR  : More Than One Record Found: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
      }
      return getFieldsResult;
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ' ERROR : Search Asset API -- ' + JSON.stringify(err.response.data));
        return {'result': 0, 'message': JSON.stringify(err.response.data)};
      } else {
        logger.error(new Date() + logRowInfo  + ' ERROR : Search Asset API -- ' + JSON.stringify(err));
        return {'result': 0, 'message': JSON.stringify(err)};
      }
      //console.log(new Date() + ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' ERROR : Search Asset API -- ' + JSON.stringify(err.response.data));
      
    });

    logger.info(new Date() + logRowInfo +  ' INFO : End Processing Row');    
    logger.info(new Date() + logRowInfo + ' INFO : ###################################');
    logger.info(new Date() + ' ');
  
  return APIResult;
};


/**
 * Search for Template Record with JOB-ID: job_999999999 and KBObjectID: 999999999 
 * @param {*} File Name, CSV Row Data
 */
searchTemplateAsset = async () => {
  
  let token = await getObjectDefault("/token", "null");

  let queryString = '';
  queryString = "'999999999'" + " and FieldName('mpe_job_id') = 'job_999999999'";

  logger.info(new Date() + ': SearchTemplateAsset: ');
  let APIResult = await axios
    .get(APR_CREDENTIALS.SearchAsset + encodeURI(queryString), 
    { 
      timeout: 60000,
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
        logger.info(new Date() + ': ERROR: TemplateAsset Not Found. Please Check Aprimo.');
      } else if (itemsObj.totalCount === 1) {
          //logger.info(new Date() + ': TemplateAsset ID:'+ itemsObj.items[0].id );
          getFieldsResult = itemsObj.items[0].id;
      }else{
        logger.info(new Date() + ': ERROR: TemplateAsset Found More Than One. Please Check Aprimo.');
      }
      return getFieldsResult;
    })
    .catch(async (err) => {
      logger.info(new Date() + ': ERROR: Search TemplateAsset API ');
      return 0;
    });
  return APIResult;
};

/**
 * Check File Size
 * @param {*} File Name
 */
getFilesizeInMegabytes = async (filename) => {
  var stats = fs.statSync(filename);
  var fileSizeInBytes = stats.size;
  var fileSizeInMegabytes = fileSizeInBytes / (1024 * 1024);
  //console.log("fileSizeInMegabytes:", fileSizeInMegabytes);
  return fileSizeInMegabytes;
};

/**
 * 
 * Check fields Create/Update. No need of Token in this function
 * @param {*} assetID, Row Data
 */  
getFields = async (assetID, recordsCollection) => {

  let existImgId;
  let filename;
  let APIResult = 0;

  if (assetID === "null") {
    //Create New
    filename = recordsCollection.BINARY_FILENAME;
    existImgId = "null";

    try {
      if(recordsCollection.BINARY_FILENAME === '' && recordsCollection.LV_ID === ''){
            logger.info(new Date() + logRowInfo + ' INFO : Create Meta Start: ');
            APIResult = await createMeta(assetID, recordsCollection, 'null');
            logger.info(new Date() + logRowInfo + ' INFO : Create Meta End: ');
      } else {
        const ImageToken = await uploadAsset(filename, recordsCollection.JOB_ID);
        //console.log(new Date() + ": INFO : Create Meta:");
        logger.info(new Date() + logRowInfo + ' INFO : Create Meta Start: ');
        APIResult = await createMeta(assetID, recordsCollection, ImageToken);
        logger.info(new Date() + logRowInfo + ' INFO : Create Meta End: ');
      }
    } catch (error) {
      //console.log(new Date() + ": ERROR  : Create Meta: "+ error);
      logger.error(new Date() + logRowInfo + ': ERROR  : Create Meta: '+ error);
      APIResult = {'result': 0, 'message': error};
    }
  } else {
    try {
      logger.info(new Date() + logRowInfo + ' INFO : Create Meta Start: ');
      APIResult = await createMeta(assetID, recordsCollection, 'null');
      logger.info(new Date() + logRowInfo + ' INFO : Create Meta End: ');
    } catch (error) {
      //console.log(new Date() + ': PID: '+ assetID + ' ERROR  : Create Meta: ' + error);
      logger.info(new Date() + logRowInfo + ' ERROR  : Create Meta: ' + error);
      APIResult = {'result': assetID, 'message': error};
    }
  }
  return APIResult;
};

/**
 * 
 * Find fields IDs for updating records. 
 */  
getFieldIDs = async () => {
  
  let token = await getObjectDefault("/token", "null");

  let tempAssetID = await searchTemplateAsset();
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
        return resp.data.items;
      } else {
        //logger.error(new Date() + ': ERROR : tempAssetID Missing --');
        //console.log(new Date() + ': ERROR : tempAssetID Missing --');
        return null;
      }
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': ERROR : Template FieldIDs -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': ERROR : Template FieldIDs -- ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
      return null;
    });

    return getFieldsResult;
  } else {
    return null;
  }
};

/**
 * 
 * Find fields IDs for updating records. 
 * @param {*} fieldName
 */  
findFieldID = async (fieldName) => {
  
  let token = await getObjectDefault("/token", "null");

  let getFieldsResult = await axios
    .get(APR_CREDENTIALS.SearchFieldByName + fieldName, {
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
        logger.error(new Date() + logRowInfo + ': DATA ERROR : Field Not Found -- ' + fieldName);
        //console.log(new Date() + ': ERROR : tempAssetID Missing --');
        return null;
      }
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': API ERROR : getFieldIDs -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': API ERROR : getFieldIDs -- ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
      return null;
    });
  return getFieldsResult;
};
/**
 * 
 * createMeta for updating records. 
 * @param {*} assetID, Row data, ImgToken
 */  
createMeta = async (assetID, data, ImgToken) => {  
  let APIResult = false;
  let tempAssetObj = await getFieldIDs();  
  let NewAssetTypeID = findObject(tempAssetObj, 'fieldName', 'NewAssetType');
  let updateObj = {
    tag: "<xml>test tag</xml>",
    classifications: {
      addOrUpdate: []
    },
    fields: {
      addOrUpdate: []
    },
  };
  
  //console.log("ImgToken:", ImgToken);
  if (ImgToken !== "null" && ImgToken !== undefined) {
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


  //try {
    
  let ClassObj = [];
  let CSORELEASE = [];

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
      case 'AGENCY':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_agency');
        if (ObjectID.hasOwnProperty('0')) {
          APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key], key)
          if (APIResult !== 'null') {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        break;
      case 'BRAND'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_brand');
        if (ObjectID.hasOwnProperty('0')) {
          APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key], key)
          if (APIResult !== 'null') {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        break;
      case 'BU': //Classification (Hierarchical)        
        /*
        APIResult = await searchClassificationName(tmpKey, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        
          ObjectID = findObject(tempAssetObj, 'fieldName', 'New_Ownership');
          if (ObjectID.hasOwnProperty('0')) {
            //console.log("ObjectID", ObjectID.length);
            if(ObjectID.length === 0){
              ObjectID = await findFieldID('New_Ownership');
            }
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": ClassID,
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Create Meta: ' + key);
          }            
        }
        */
        break;        
      case 'CONTACT'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_contact');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'DEPT'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'ResponsibleDepartment');
        if (ObjectID.hasOwnProperty('0')) {
          APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key], key)
          if (APIResult !== 'null') {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'DESC'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_desc');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'DESCRIPTION'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_description');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'DESCRIPTION_POD'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_description_pod');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'FILENAME':
        // code block
        break;
      case 'HEADLINE'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_headline');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;  
      case 'ILABEL':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_ilabel');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
          // code block
        break;
      case 'IMG_TYPE': //Classification (Hierarchical)        
        APIResult = await searchClassificationName(tmpKey, data, key);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_img_type');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": ClassID,
                "languageId": "00000000000000000000000000000000"
              }]
            });  
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }            
        }
        // code block
        break;
      case 'IMG_TYPE_HAWERA': //Classification (Hierarchical)
        
        APIResult = await searchClassificationName(tmpKey, data, key);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_img_type_hawera');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": ClassID,
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
        }
        // code block
        break;        
      case 'INIT_NAME':
          ObjectID = findObject(tempAssetObj, 'fieldName', 'Init Name');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "value": data[key],
                "languageId": "00000000000000000000000000000000"
              }]
            });
  
          var firstName = data[key].substring(0, data[key].lastIndexOf(" ") + 1);
          var lastName = data[key].substring(data[key].lastIndexOf(" ") + 1, data[key].length);
  
          APIResult = await searchUser(firstName, lastName);
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
  
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
          // code block
          break;
      case 'KEYWORDS':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Keywords');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": [data[key]],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }        // code block
        break;    
      case 'LAUNCH_DATE':
        let LAUNCH_DATE_VAR = new Date(data[key]);
        ObjectID = findObject(tempAssetObj, 'fieldName', 'LaunchDate');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": LAUNCH_DATE_VAR,
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'ORIG_BE_ID'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_orig_be_id');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'PERSPECTIVE'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_perspective');
        if (ObjectID.hasOwnProperty('0')) {
          APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key],  key)
          if (APIResult !== 'null') {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'PHOTOGRAPHER'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_photographer');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'PRODUCTION_AGENCY'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_production_agency');
        if (ObjectID.hasOwnProperty('0')) {
          APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key],  key)
          if (APIResult !== 'null') {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'STATUS':
          APIResult = await searchClassificationName(tmpKey, data, key);
          if (APIResult !== 'null') {
            ClassID.push(APIResult);
            ObjectID = findObject(tempAssetObj, 'fieldName', 'Status');
            if (ObjectID.hasOwnProperty('0')) {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": [{
                  "values": ClassID,
                  "languageId": "00000000000000000000000000000000"
                }]
              });
            }else{
              logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
            }
          }
          // code block
          break;
      case 'SYMBOLIMG_DESCRIPTION'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_symbolimg_description');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "value": data[key],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;
      case 'TITLE'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_title');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "value": data[key],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;
      case 'TRADE_LABEL_AGENCY'://Option List
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_agency');
          if (ObjectID.hasOwnProperty('0')) {
            APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key],  key)
            if (APIResult !== 'null') {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": [{
                  "values": [APIResult],
                  "languageId": "00000000000000000000000000000000"
                }]
              });
            }
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;
      case 'TRADE_LABEL_BRAND'://Option List
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_brand');
          if (ObjectID.hasOwnProperty('0')) {
            APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key],  key)
            if (APIResult !== 'null') {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": [{
                  "values": [APIResult],
                  "languageId": "00000000000000000000000000000000"
                }]
              });
            }
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;
      case 'TRADE_LABEL_CONTACT'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_contact');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "value": data[key],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;
      case 'TRADE_LABEL_DEPT'://Option List
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_dept');
          if (ObjectID.hasOwnProperty('0')) {
            APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key],  key)
            if (APIResult !== 'null') {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": [{
                  "values": [APIResult],
                  "languageId": "00000000000000000000000000000000"
                }]
              });
            }
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;      
      case 'TRADE_LABEL_EAN'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_ean');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "value": data[key],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;
      case 'TRADE_LABEL_KEYWORDS'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_keywords');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [data[key]],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;
      case 'TRADE_LABEL_PERSPECTIVE'://Option List
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_perspective');
          if (ObjectID.hasOwnProperty('0')) {
            APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key],  key)
            if (APIResult !== 'null') {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": [{
                  "values": [APIResult],
                  "languageId": "00000000000000000000000000000000"
                }]
              });
            }
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
          // code block
          break;
      case 'CATEGORY_TREE_IDS'://text
        if (typeof tmpKey === 'string'){
          let str_array = tmpKey.split('\\\\');

          for (let splitIndex = 0; splitIndex < str_array.length; splitIndex++) {
            // Trim the excess whitespace.
            let treeIDs = str_array[splitIndex];
            let pieces = treeIDs.split(/[\s\|\|]+/);
            let lastValue = pieces[pieces.length - 1];
            lastValue = lastValue.replace(/^\s*/, "").replace(/\s*$/, "");
            if(lastValue !== null){
              let APIResult = await searchClassificationID(lastValue, data, key)
              if (APIResult !== 'null') {
                ClassID.push(APIResult);
              }  
            }
          }
        }
        
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Kittelberger Category Tree Ids');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'CATEGORY_TREE_NAMES':
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
            if (ObjectID.hasOwnProperty('0')) {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": [{
                  "value": data[key],
                  "languageId": "00000000000000000000000000000000"
                }]
              });
            }else{
              logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
            }
            // code block
            break;
      case 'LTYPE_ID':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_ltype_id');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'LTYPE_NAME':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_ltype_name');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'LV_ID':
          ObjectID = findObject(tempAssetObj, 'fieldName', 'Kittelberger ID');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "value": data[key],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
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
      case 'NAME':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Title');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'OBJ_ID':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_obj_id');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        break;
      case 'ORIGINAL_FILENAME':
        // code block
        break;
      case 'OTYPE_ID':
        APIResult = await searchClassificationID(data[key], data, key);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_object_type');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }

        }


          let AssetTypeKey = findObject(oTypes, 'OTYPE_ID', data[key]);
          if (NewAssetTypeID.hasOwnProperty('0') && AssetTypeKey.hasOwnProperty('0')) {
            APIResult = await searchClassificationID(AssetTypeKey[0].id, data, key);
            //console.log("APIResult", APIResult);
            if (APIResult !== 'null') {
              ClassID.push(APIResult);
              updateObj.fields.addOrUpdate.push({
                "id": NewAssetTypeID[0].id,
                "localizedValues": [{
                  "values": [APIResult],
                  "languageId": "00000000000000000000000000000000"
                }]
              });
            }
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
        // code block
        break;
      case 'OTYPE_NAME':
        // code block
        break;
      case 'SYSTEM_STATUS':
        APIResult = await searchClassificationID('mpe_' + data[key], data, key);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
          ObjectID = findObject(tempAssetObj, 'fieldName', 'SystemStatus');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
        }
        // code block
        break;
      //Other Old Mapped Fields
      case 'BINARY_FILENAME':
        // code block
        break;
      case 'CSORELEASE_MASTER':
        if (data[key] === 'x') {
          optionVal = "True"
        }
        ObjectID = findObject(tempAssetObj, 'fieldName', 'BI_Master');
        if (ObjectID.hasOwnProperty('0')) {
          APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], optionVal,  key)
          if (APIResult !== 'null') {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'INIT_DATE':
        // code block
        break;
      /*
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
        APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], optionVal,  key)
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
      */
      case 'MISSING_TTNR':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'Missing_TTNR');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      /*
      case 'AC_MAIN_USAGE':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'IntendedUsage');
        APIResult = await getfielddefinitionID(ObjectID[0]['_links']['definition']['href'], data[key],  key)
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
      */
      case 'LINKED_PRODUCTS':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'ReferencedProductsinPIM');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;
      case 'CLIPLISTER_LINKS':
        // code block
        break;
      case 'COLOR_SPACE':
        // code block
        ObjectID = findObject(tempAssetObj, 'fieldName', 'ColorSpace');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });   
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }     
        break;
      case 'JOB_ID'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_job_id');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        // code block
        break;  
      case 'PRIMEMEDIAPOOL$DEFAULT$RELATED_COUNTRIES':
        let PoolCode = data[key].split(',');
        if (PoolCode.length > 0) {
          for (let i = 0; i < PoolCode.length; i++) {
            if (PoolCode[i].length > 0) {
              if (PoolCode[i] !== 'null') {
                if (CSORELEASE.indexOf(PoolCode[i].trim()) === -1){
                  let keyMapPC = await getObjectDefault("/mapping/"+ PoolCode[i].trim(), "Null");
                  if(keyMapPC === 'Null'){
                    CSORELEASE.push(PoolCode[i].trim());
                  }else if(keyMapPC === 'ignore'){
                    //Ignore the Value
                  }else{
                    CSORELEASE.push(keyMapPC);
                  }
                }
              }
            }
          }
        }
        break;  
      case 'PRIMEPOOL_BU':
        let PoolCodeBU = data[key].split(',');
        if (PoolCodeBU.length > 0) {
          for (let i = 0; i < PoolCodeBU.length; i++) {
            if (PoolCodeBU[i].length > 0) {
              if (PoolCodeBU[i] !== 'null') {
                if (CSORELEASE.indexOf(PoolCodeBU[i].trim()) === -1){
                  
                  let keyMapBU = await getObjectDefault("/mapping/"+ PoolCodeBU[i].trim(), "Null");
                  if(keyMapBU === 'Null'){
                    CSORELEASE.push(PoolCodeBU[i].trim());
                  }else if(keyMapBU === 'ignore'){
                    //Ignore the Value
                  }else{
                    CSORELEASE.push(keyMapBU);
                  }
                }                
              }
            }
          }
        }
        break;
      case 'RESPONSIBLE_BUSINESS_UNIT':
        if(data['RESPONSIBLE_BUSINESS_UNIT'] !== '' && data['RESPONSIBLE_BUSINESS_UNIT'] !== null){
          APIResult = await searchClassificationID('Ownership_' + data['RESPONSIBLE_BUSINESS_UNIT'], data, key);
        }else{
          APIResult = await searchClassificationID('Ownership_Other', data, key);
        }
        if (APIResult !== 'null') {
          //ClassObj.push(APIResult);
          ObjectID = findObject(tempAssetObj, 'fieldName', 'New_Ownership');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });

            let ReleaseResult = '';
            if(data["RELEASED"] === 'x'){//ReleaseInfoPublic
              ReleaseResult = await searchClassificationID('ReleaseInfoPublic', data, key);
            }else if(data["RELEASED"] === '-'){//ReleaseInfoInternal
              ReleaseResult = await searchClassificationID('ReleaseInfoInternal', data, key);
            }else {//ReleaseInfoRestricted
              ReleaseResult = await searchClassificationID('ReleaseInfoRestricted', data, key);
            }

          let releasedInfoID = findObject(tempAssetObj, 'fieldName', 'New_ReleaseInfo');
          if (releasedInfoID.hasOwnProperty('0') && ReleaseResult !== 'null') {
            updateObj.fields.addOrUpdate.push({
              "id": releasedInfoID[0].id,
              "localizedValues": [{
                "values": [ReleaseResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
            //ClassObj.push(ReleaseResult);
          }

          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
        }else{
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        break;


      case 'Language':
        let keyMap = await getObjectDefault("/mapping/"+ data[key], "Null");
        if(keyMap === 'Null'){
          APIResult = await searchClassificationID('Language_' + data[key], data, key);
        }else{
          APIResult = await searchClassificationID(keyMap, data, key);
        }
        
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
          ObjectID = findObject(tempAssetObj, 'fieldName', 'New_MAM_Languages');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
          }
        }
        // code block
        break;

      case 'Languages':
        //console.log("Languages Start");
        let tmpString = data[key];
        if (typeof tmpString === 'string'){        
          let strRegex = /\((.*?)\)/g;
          let strMatches = tmpString.match(strRegex);
          let strValues = strMatches.map(strMatch => strMatch.slice(1, -1));
        
          let mpeHeadlineArray = [];
          let mpeSubHeadlineArray = [];
          let mpeURLArray = [];
          //console.log("strValues: ", strValues);
          for (let strValuesIndex = 0; strValuesIndex < strValues.length; strValuesIndex++) {
            if (typeof strValues[strValuesIndex] === 'string'){
              let langArray = strValues[strValuesIndex].split(',');
                if (langArray.hasOwnProperty('0')) {
                  //Get Language ID
                  let getLanguageId = await GetLanguageID(langArray[0]);//"c2bd4f9bbb954bcb80c31e924c9c26dc";
                  if (langArray.hasOwnProperty('1')) {
                    mpeHeadlineArray.push({
                      "value": langArray[1],
                      "languageId": getLanguageId,
                    });
                  }
                  if (langArray.hasOwnProperty('2')) {
                    mpeSubHeadlineArray.push({
                      "value": langArray[2],
                      "languageId": getLanguageId,
                    });
                  }
                  if (langArray.hasOwnProperty('3')) {
                    mpeURLArray.push({
                      "value": langArray[3],
                      "languageId": getLanguageId,
                    });
                  }
                }
            }
          }

          if(mpeHeadlineArray.hasOwnProperty('0')){
            ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_headline');
            if (ObjectID.hasOwnProperty('0')) {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": mpeHeadlineArray
              });
            }  
          }

          if(mpeSubHeadlineArray.hasOwnProperty('0')){
            ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_subheadline');
            if (ObjectID.hasOwnProperty('0')) {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": mpeSubHeadlineArray
              });
            }  
          }

          if(mpeURLArray.hasOwnProperty('0')){
            ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_URL');
            if (ObjectID.hasOwnProperty('0')) {
              updateObj.fields.addOrUpdate.push({
                "id": ObjectID[0].id,
                "localizedValues": mpeURLArray
              });  
            }
          }
        }

        break;
      default:
        if(key.indexOf("CSORELEASE_") !== -1){
          if(data[key] === 'x'){
            let CSOCode = key.split('_');
            if (CSOCode.hasOwnProperty('1')) {
              if (CSORELEASE.indexOf(CSOCode[1].trim()) === -1){
                let keyMap = await getObjectDefault("/mapping/"+ CSOCode[1].trim(), "Null");
                if(keyMap === 'Null'){
                  CSORELEASE.push(CSOCode[1].trim());
                }else if(keyMap === 'ignore'){
                  //Ignore the Value
                }else{
                  CSORELEASE.push(keyMap);
                }
              }
            }
          }
        } 
        break;
        // code block
    }
    

    if (ClassID?.length !== undefined && ClassID.length > 0) {
      for (let i = 0; i < ClassID.length; i++) {
        if (ClassID[i]?.length !== undefined && ClassID[i].length > 0) {
          if (ClassID[i] !== 'null') {
            ClassObj.push(ClassID[i]);
          }
        }
      }
    }
  }

  //Security Authorized Code Start
  if (CSORELEASE.length > 0) {
    let CSOArray = [];
    let AuthorizedOther = await searchClassificationID('Authorized_Other', data, 'CSORELEASE_Other');
    
    for (let cs = 0; cs < CSORELEASE.length; cs++) {
      //console.log("SecurityAuthorized: ", 'SecurityAuthorized_'+CSORELEASE[cs]);
      APIResult = await searchClassificationID('Authorized_' + CSORELEASE[cs], data, 'CSORELEASE_' + CSORELEASE[cs]);
      if (APIResult !== 'null') {
        //ClassObj.push(APIResult);
        CSOArray.push(APIResult);
      }else{
        if(!CSOArray.includes(AuthorizedOther)){
          //CSOArray.push(AuthorizedOther);
        }
      }
    }
    ObjectID = findObject(tempAssetObj, 'fieldName', 'New_Authorized');
    if (ObjectID.hasOwnProperty('0')) {
      updateObj.fields.addOrUpdate.push({
        "id": ObjectID[0].id,
        "localizedValues": [{
          "values": CSOArray,
          "languageId": "00000000000000000000000000000000"
        }]
      });
    }
  }
  //Security Authorized Code End

  for (let c = 0; c < ClassObj.length; c++) {
    updateObj.classifications.addOrUpdate.push({
      "id": ClassObj[c],
      "sortIndex": c
    });
  }
  //console.log("ClassObj: ", ClassObj);  
/*
  } catch (error) {
    logger.info(new Date() + logRowInfo + ' API ERROR : META:' + error);
    console.log(' ERROR : META:', error);
  }
*/

  //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + ' INFO : Update JSON:' + JSON.stringify(updateObj));
  //return false;


  logger.info(new Date() + logRowInfo + ' INFO : Update JSON:' + JSON.stringify(updateObj));
  
  
  let token = await getObjectDefault("/token", "null");

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
          logger.info(new Date() + logRowInfo + ' INFO : Record ID: ' + resp.data.id);
          //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + ' INFO : Record ID: ' + resp.data.id);

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
          if(dataFlag){
            return {'result': resp.data.id, 'message': 'RECORD CREATED'};
          }else{
            return {'result': resp.data.id, 'message': 'RECORD CREATED WITH DATA ERROR'};
          }          
        } else {
          logger.error(new Date() + logRowInfo + ' ERROR : GETTING RECORD ID -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
          //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : GETTING RECORD ID -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
          logger.error(new Date() + logRowInfo + ' ERROR : GETTING RECORD ID -- ' + JSON.stringify(resp));
          //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : GETTING RECORD ID -- ' + JSON.stringify(resp));
          return {'result': 0, 'message': JSON.stringify(resp)};
        }
      })
      .catch((err) => {
        if(err.response !== undefined && err.response.data !== undefined){
          logger.error(new Date() + logRowInfo + ' ERROR : CREATE RECORD API -- ' + JSON.stringify(err.response.data));        
          return {'result': 0, 'message': JSON.stringify(err.response.data)};
        } else {
          logger.error(new Date() + logRowInfo + ' ERROR : CREATE RECORD API -- ' + JSON.stringify(err));
          return {'result': 0, 'message': JSON.stringify(err)};
        }
  
        //logger.error(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : CREATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
        //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : CREATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
        //logger.error(new Date() + ': PID: '+ data["OBJ_ID"] + ' ERROR : CREATE RECORD API -- ' + JSON.stringify(err));
        //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + ' ERROR : CREATE RECORD API -- ' + JSON.stringify(err));
        
        //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : CREATE RECORD API -- ' + JSON.stringify(err.response.data));
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
        logger.info(new Date() + logRowInfo + ' INFO : Record Updated: ' + assetID);
        //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' INFO : Record Updated: ' + assetID);

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
    
        ////console.log(': Update Record ID: ');
        if(dataFlag){
          return {'result': assetID, 'message': 'RECORD UPDATED'};
        }else{
          return {'result': resp.data.id, 'message': 'RECORD UPDATED WITH DATA ERROR'};
        }
      })
      .catch((err) => {
        logger.error(new Date() + logRowInfo + ' ERROR : UPDATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID' + data.OBJ_ID + ' Asset ID: ' + assetID);
        //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : UPDATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID' + data.OBJ_ID);
        if(err.response !== undefined && err.response.data !== undefined){
          logger.error(new Date() + logRowInfo + ' ERROR : UPDATE RECORD API -- ' + JSON.stringify(err.response.data));
          return {'result': 0, 'message': JSON.stringify(err.response.data)};
        } else {
          logger.error(new Date() + logRowInfo + ' ERROR : UPDATE RECORD API -- ' + JSON.stringify(err));
          return {'result': 0, 'message': JSON.stringify(err)};
        }        
      });
    return reqCreatRequest;
  }

};

/**
 * 
 * Search for User Data
 * @param {*} firstName, lastName
 */ 
searchUser = async (firstName, lastName) => {
  
  let token = await getObjectDefault("/token", "null");

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


  logger.info(new Date() + logRowInfo + ': INFO : Search USER ID: ' + JSON.stringify(body));
  //console.log(new Date() + ': INFO : Search USER ID: ', JSON.stringify(body));
  logger.info(new Date() + logRowInfo + ': INFO : Search USER URL: ' + APR_CREDENTIALS.SearchUser);
  //console.log(new Date() + ': INFO : Search USER URL: ', APR_CREDENTIALS.SearchUser);
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
          logger.info(new Date() + logRowInfo + ': INFO : USER ID: ', resp.data['_embedded'].user[0].adamUserId);
          //console.log(new Date() + ': INFO : USER ID: ', resp.data['_embedded'].user[0].adamUserId);
          return resp.data['_embedded'].user[0].adamUserId;
        } else {
          logger.error(new Date() + logRowInfo + ': ERROR : USER NOT FOUND -- First Name: ' + firstName + ' Last Name: ' + lastName);
          //console.log(new Date() + ': ERROR : USER NOT FOUND -- First Name: ' + firstName + ' Last Name: ' + lastName);
          return '0';
        }
      })
      .catch((err) => {
        logger.error(new Date() + logRowInfo + ': ERROR : USER SEARCH API -- First Name: ' + firstName + ' Last Name: ' + lastName);
        //console.log(new Date() + ': ERROR : USER SEARCH API -- First Name: ' + firstName + ' Last Name: ' + lastName);

        if(err.response !== undefined && err.response.data !== undefined){
          logger.error(new Date() + logRowInfo + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err.response.data));
        } else {
          logger.error(new Date() + logRowInfo + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err));
        }

        //console.log(new Date() + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err.response.data));
        return '0';
      });
    return reqCreatRequest;
};

/**
 * 
 * Get GetLanguageID
 * @param {*} token, fieldValue, keyValue
 */ 

GetLanguageID = async (langValue) => {
  let token = await getObjectDefault("/token", "null");
  let langKey = await getObjectDefault("/languagemapping/"+langValue, "ignore");
  
  let searchClass = await axios
  .get(APR_CREDENTIALS.BaseURL + '/core/languages',
    {
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        "API-VERSION": APR_CREDENTIALS.Api_version,
        Authorization: `Bearer ${token}`,
      },
    }
  )
  .then(async (resp) => {
    const langObj = resp.data;
    if (langObj.totalCount !== 0) {
      let LangID = findObject(langObj.items, 'culture', langKey);
      if (LangID.hasOwnProperty('0')) {
        return LangID[0].id
      }else{
        return langObj.items[0].id;
      }
    } else {
      logger.error(new Date() + logRowInfo + ': API ERROR : GetLanguageID -- ' + langValue);
    }
  })
  .catch(async (error) => {
      logger.error(new Date() + logRowInfo + ': API ERROR : GetLanguageID -- ' + langValue);
      return null;
  });
  return searchClass;
};


/**
 * 
 * Get Template Field for definition
 * @param {*} fieldURL, fieldValue, keyValue
 */ 
getfielddefinitionID = async (fieldURL, fieldValue, keyValue) => {
  
  let token = await getObjectDefault("/token", "null");
  let fieldData = await getObjectDefault("/fieldIDs/"+ fieldValue, "null");
  
  if (fieldData === 'null') {  
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
      ////console.log("resp.data:--------", resp.data);
      ObjectID = findObject(resp.data.items, 'label', fieldValue);
      ////console.log("ObjectID:--------", ObjectID);
      if (ObjectID.length > 0) {
        ////console.log(new Date() + ': ObjectID.id -- ' + ObjectID[0].id);
        await db.push("/fieldIDs/"+fieldValue, ObjectID[0].id);
        await db.save();
        return ObjectID[0].id;
      } else {
        //console.log(new Date() + ': ERROR : Field Definition -- ' + fieldURL);
        logger.error(new Date() + logRowInfo + ': OPTION LIST ERROR : Field Definition -- ' + fieldURL);
        //console.log(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);
        logger.error(new Date() + logRowInfo + ': OPTION LIST ERROR : Field Definition Key: ' + keyValue + ' Value: ' + fieldValue);
        dataFlag = false;
        return 'null';
      }
    })
    .catch(async (err) => {
      //console.log(new Date() + ': ERROR : Field Definition API -- ' + fieldURL);
      //console.log(new Date() + ": ERROR : Field Definition API -- ", JSON.stringify(err.response.data));
      logger.error(new Date() + logRowInfo + ': API ERROR : Field Definition API -- ' + fieldURL);
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': API ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': API ERROR : is ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);
      logger.error(new Date() + logRowInfo + ': API ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);
      dataFlag = false;
      return 'null';
    });
    return resultID;
  
  
  } else {
    return fieldData;
  }

};


getObjectDefault = async(key, defval) => {
  //console.log('I am in 001', key);
  let data = defval;
  try {
    if(key === '/token'){
      await dbtoken.reload();
      data = await dbtoken.getData(key);
    } else if (key.includes('/mapping')){
      await kMap.reload();
      data = await kMap.getData(key);
    } else if (key.includes('/languagemapping')){
      await langMap.reload();
      data = await langMap.getData(key);
    } else {
      await dbtoken.reload();
      data = await db.getData(key);
    }
  } catch (innerError) {
    //console.log('error', innerError.message);
    if(innerError.message.includes("find dataPath")){
      return data;
    }else if(innerError.message.includes("Load Database")){
      logger.error(new Date() + logRowInfo + ' DATABASE ERROR : ' + innerError.message);
      if (retries < maxRetries) {
        retries++;
        logger.error(new Date() + logRowInfo + ' DATABASE Retrying: ' + retries);
        //setTimeout(getObjectDefault(key, defval), retryDelay);
        setTimeout(async function() {
          await getObjectDefault(key, defval);
        }, retryDelay);
      } else {
        logger.error(new Date() + logRowInfo + ' DATABASE Max retries exceeded. Unable to load database. ');
      }
    }
  }
  return data;
};

/**
 * 
 * Search for Classificate Name
 * @param {*} ClassID, data
 */ 
searchClassificationName = async (ClassID, data, key) => {
  let token = await getObjectDefault("/token", "null");
  let fieldData = await getObjectDefault("/fieldIDs/"+ ClassID, "null");

  if (fieldData === 'null') {    
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

        await db.push("/fieldIDs/"+ClassID, itemsObj.items[0].id);
        await db.save();
        return itemsObj.items[0].id;
      } else if (itemsObj.totalCount > 1) {
        clogger.info(new Date() + logRowInfo + ': DATA ERROR : Classification found more than one: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        logger.error(new Date() + logRowInfo + ': DATA ERROR : Classification found more than one: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        dataFlag = false;
        return 'null';
      } else {
        clogger.info(new Date() + logRowInfo + ': DATA ERROR : Classification is missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        logger.info(new Date() + logRowInfo + ': DATA ERROR : Classification is missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        return 'null';
      }
    })
    .catch(async (err) => {
      clogger.info(new Date() + logRowInfo + ': Classification API ERROR : Classification is missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
      logger.error(new Date() + logRowInfo + ': Classification API ERROR : Classification is missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
      //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
      if(err.response !== undefined && err.response.data !== undefined){
        logger.warn(new Date() + logRowInfo + ': Classification API ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.warn(new Date() + logRowInfo + ': Classification API ERROR : is ' + JSON.stringify(err));
      }
      dataFlag = false;
      return 'null';
    });
    return resultID;  
  } else {
      return fieldData;
  }
};


/**
 * 
 * Search for Classificate Name
 * @param {*} ClassID, data
 */ 
searchClassificationID = async (ClassID, data, key) => {
  
  let token = await getObjectDefault("/token", "null");
  let fieldData = await getObjectDefault("/fieldIDs/"+ ClassID, "null");

  if (fieldData === 'null') {   
  let resultID = await axios
    .get(APR_CREDENTIALS.GetClassificationByID + "'" + encodeURI(ClassID) + "'", {
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
        //console.log("Field Value: ", itemsObj.items[0].id);
        await db.push("/fieldIDs/"+ClassID, itemsObj.items[0].id);
        await db.save();
        return itemsObj.items[0].id;
      } else if (itemsObj.totalCount > 1) {
        clogger.info(new Date() + logRowInfo + ': DATA ERROR : Classification found more than one: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        logger.error(new Date() + logRowInfo + ': DATA ERROR : Classification found more than one: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        dataFlag = false;
        return 'null';
      } else {
        clogger.info(new Date() + logRowInfo + ': DATA ERROR : Classification is missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        logger.error(new Date() + logRowInfo + ': DATA ERROR : Classification is missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        dataFlag = false;
        return 'null';
      }
    })
    .catch(async (err) => {
      logger.error(new Date() + logRowInfo + ': API ERROR : Classification is missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
      //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
      if(err.response !== undefined && err.response.data !== undefined){
        logger.warn(new Date() + logRowInfo + ': API ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.warn(new Date() + logRowInfo + ': API ERROR : is ' + JSON.stringify(err));
      }
      dataFlag = false;
      return 'null';
    });
    return resultID;
  } else {
    return fieldData;
  }

};
/**
 * Upload file into Aprimo
 * @param {*} filename 
 */
async function uploadAsset(filename, processPath) {
  
  let token = await getObjectDefault("/token", "null");

  let BINARY_FILENAME = filename
  let remotePath = APR_CREDENTIALS.sourcePath + '/'+ processPath + '/binary/' + filename;
  filename = imgFolderPath + filename;
  
  logger.info(new Date() + logRowInfo + ': Start Downloading: ' + filename);
  let sftp = new Client();
  await sftp.connect(ftpConfig)
    .then(async () => {      
      await sftp.fastGet(remotePath, filename);
      logger.info(new Date() + logRowInfo + ': End Downloading: ' + filename);
    }).catch(e => {
      logger.error(new Date() + logRowInfo + ': FTP ERROR : in the FTP Connection -- ' + e);
      dataFlag = false;
      //console.log(new Date() + ': ERROR : in the FTP Connection -- ' + e);
    });
    

    if (fs.existsSync(filename) && BINARY_FILENAME !== '') {
      let varFileSize = await getFilesizeInMegabytes(filename);
      //let varFileSizeByte = varFileSize * (1024 * 1024);
      let getMimeType = mime.lookup(filename);
      let APIResult = null;
      if (varFileSize > 1) {


            let SegmentURI = await getSegmentURL(filename);
            APIResult = await splitFile
              .splitFileBySize(filename, 10000000)
              .then(async (names) => {
                for (let start = 0; start < names.length; start++) {
                    await uploadSegment(
                      SegmentURI + "?index=" + start,
                      names[start]
                    );                  
                }
                

                  logger.info(new Date() + logRowInfo + ': Start Uploading Chunks: ' + filename);
                  const ImgToken = await commitSegment(SegmentURI, filename, names.length);

                  // Delete Main File 
                  fs.unlink(filename, (err) => {
                    if (err){
                      logger.error(new Date() + logRowInfo + ': ERROR : File Deletion -- ' + JSON.stringify(err));
                      //console.log(new Date() + ': ERROR : File Deletion -- ' + JSON.stringify(err));    
                    } 
                  });
                  // Delete Segment Files
                  for (let start = 0; start < names.length; start++) {
                    fs.unlink(names[start], (err) => {
                      if (err){
                        logger.error(new Date() + logRowInfo + ': ERROR : File Deletion -- ' + JSON.stringify(err));
                        //console.log(new Date() + ': ERROR : File Deletion -- ' + JSON.stringify(err));    
                      }
                    });
                  }
                  logger.info(new Date() + logRowInfo + ': End Uploading Chunks: ' + filename);
                  return ImgToken;  
              })
              .catch((err) => {
                if(err.response !== undefined && err.response.data !== undefined){
                  logger.error(new Date() + logRowInfo + ': API ERROR : Upload API -- ' + JSON.stringify(err.response.data));
                } else {
                  logger.error(new Date() + logRowInfo + ': API ERROR : upload API -- ' + JSON.stringify(err));
                }
          
                //console.log(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err.response.data));
                return null;
              });
            return APIResult;
      } else {
        //logger.info(new Date() + ": fileSize is < 20 MB: ");
        logger.info(new Date() + logRowInfo + ': Start Uploading: ' + filename);
        let form = new FormData();
        form.append("file", fs.createReadStream(filename), {
          contentType: getMimeType,
          filename: BINARY_FILENAME,
        });

        
        token = await getObjectDefault("/token", "null");
      
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

              fs.unlink(filename, (err) => {
                if (err){
                  logger.error(new Date() + logRowInfo + ': ERROR : File Deletion -- ' + JSON.stringify(err));
                } 
              });  

            logger.info(new Date() + logRowInfo + ': End Uploading: ' + filename);
            return ImgToken;
          })
          .catch((err) => {
            if(err.response !== undefined && err.response.data !== undefined){
              logger.error(new Date() + logRowInfo + ': API ERROR : Upload API -- ' + JSON.stringify(err.response.data));
            } else {
              logger.error(new Date() + logRowInfo + ': API ERROR : Upload API -- ' + JSON.stringify(err));
            }
        
            //console.log(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err.response.data));
            return null;
          });

        return reqUploadImg;
      }



    }else{
      logger.error(new Date() + logRowInfo + ': FTP ERROR : File Not Found in the FTP -- ' + filename);
      //console.log(new Date() + ': ERROR : File Not Found in the FTP -- ' + filename);
    }
    sftp.end();

}

/***
 * Get Segment URL for Big file upload in chunks
 */
getSegmentURL = async (filename) => {
  
  let token = await getObjectDefault("/token", "null");

  let body = {
    filename: path.basename(filename)
  };
  /*
  console.log(
    "APR_CREDENTIALS.Upload_Segments_URL",
    APR_CREDENTIALS.Upload_Segments_URL
  );
  */
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
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': API ERROR : getSegment -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': API ERROR : getSegment -- ' + JSON.stringify(err));
      }
      dataFlag = false;
      //console.log(new Date() + ': ERROR : getSegment -- ' + JSON.stringify(err.response.data));
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
uploadSegment = async (SegmentURI, chunkFileName) => {
  
  let token = await getObjectDefault("/token", "null");

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
      //logger.info(new Date() + logRowInfo + ': INFO : uploadSegment Done');
      //console.log("Segment Upload Done for:", chunkFileName);
    })
    .catch((err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': API ERROR : uploadSegment -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': API ERROR : uploadSegment -- ' + JSON.stringify(err));
      }
      dataFlag = false;
    });
};

/**
 * commitSegment
 */
commitSegment = async (SegmentURI, filename, segmentcount) => {
  
  let token = await getObjectDefault("/token", "null");

  let body = {
    filename: path.basename(filename),
    segmentcount: segmentcount,
  };
  ////console.log("Commit body: ", body);
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
      return ImgToken;
    })
    .catch((err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': API ERROR : commitSegment -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': API ERROR : commitSegment -- ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : commitSegment -- ' + JSON.stringify(err.response.data));
      dataFlag = false;
      return false;
    });
  return reqUploadImg;
};

/**
 * languageRelationParent
 * @param {*} masterRecordID, childRecordID
 */
languageRelationParent = async (masterRecordID, childRecordID) => {  
  let tempAssetObj = await getFieldIDs();
  let ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_language_relation');
  //fall back
  if(ObjectID[0].id === null){
    ObjectID = '71476f4d1c854d0fa0e9af9500f3445c';
  }else{
    ObjectID = ObjectID[0].id;
  }  

  let body = {
    "fields": {
      "addOrUpdate": [{
        "id": ObjectID,
        "localizedValues": [{
          "parents": [],
          "languageId": "00000000000000000000000000000000"
        }]
      }]
    }
  }

  for (let i = 0; i < childRecordID.length; i++) {
    body.fields.addOrUpdate[0].localizedValues[0].parents.push({
      "recordId": childRecordID[i]
    });
  }
  ////console.log("URL: ", APR_CREDENTIALS.GetRecord_URL  + masterRecordID);
  ////console.log("Post: ", JSON.stringify(body));
  logger.info(new Date() + logRowInfo + ': Start languageRelationParent API: '+ masterRecordID);
  
  let token = await getObjectDefault("/token", "null");

  const resultAssets = await axios.put(APR_CREDENTIALS.GetRecord_URL  + masterRecordID,
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
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ' API ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ' API ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
      }
      //console.log(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      return false;
    });
  logger.info(new Date() + logRowInfo + ': End languageRelationParent API: '+ masterRecordID);
  return resultAssets;
};

/**
 * languageRelationParent
 * @param {*} masterRecordID, childRecordID
 */
languageRelationChild = async (masterRecordID, childRecordID) => {
  let tempAssetObj = await getFieldIDs();  
  let ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_language_relation');
  //fall back
  if(ObjectID[0].id === null){
    ObjectID = '71476f4d1c854d0fa0e9af9500f3445c';
  }else{
    ObjectID = ObjectID[0].id;
  }

  let body = {
    "fields": {
      "addOrUpdate": [{
        "id": ObjectID,
        "localizedValues": [{
          "children": [],
          "languageId": "00000000000000000000000000000000"
        }]
      }]
    }
  }

  for (let i = 0; i < childRecordID.length; i++) {
    body.fields.addOrUpdate[0].localizedValues[0].children.push({
      "recordId": childRecordID[i]
    });
  }

  ////console.log("URL: ", APR_CREDENTIALS.GetRecord_URL  + masterRecordID);
  ////console.log("Post: ", JSON.stringify(body));
  
  let token = await getObjectDefault("/token", "null");

  logger.info(new Date() + logRowInfo + ': Start languageRelationChild API: '+ masterRecordID);
  const resultAssets = await axios.put(APR_CREDENTIALS.GetRecord_URL  + masterRecordID,
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
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ' API ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ' API ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
      }
      //console.log(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      return false;
    });
  logger.info(new Date() + logRowInfo + ': End languageRelationChild API: '+ masterRecordID);
  return resultAssets;
};

/**
 * Entry point
 */
module.exports = async (rowdata) => {
  //console.log("Data:", rowdata);
  retries = 0;
  dataFlag = true;
  if(rowdata.mode === 'createRecords'){
    logRowInfo = ' : PID: ' + process.pid + ' : JobID: '+ rowdata.rowdata["JOB_ID"] +  ': OBJ_ID: '+ rowdata.rowdata["OBJ_ID"]  + '_' + rowdata.rowdata["LV_ID"];
    let timeStampStart = new Date();
    let RecordID = await searchAsset(rowdata.rowdata);
    //console.log("RecordID: ", RecordID);
    let timeStampEnd = new Date();
    rowdata.recordID = RecordID.result;
    rowdata.startTime = timeStampStart.toLocaleString();
    rowdata.endTime = timeStampEnd.toLocaleString();
    rowdata.message = RecordID.message;
    return Promise.resolve(rowdata);
  } else if(rowdata.mode === 'linkRecords'){
    logRowInfo = ': MasterRecordID: '+ rowdata.rowdata.masterRecordID +  ': ChildRecordID: '+ rowdata.rowdata.childRecordID;
    ////console.log(new Date() + ': INFO : rowdata.rowdata.masterRecordID: ' + rowdata.rowdata.masterRecordID);
    ////console.log(new Date() + ': INFO : rowdata.rowdata.childRecordID: ' + rowdata.rowdata.childRecordID);
    let recordLinksResult = await recordLinks(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID);
    //logger.info(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    ////console.log(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    return Promise.resolve(recordLinksResult);
  } else if(rowdata.mode === 'LanguageRelationParent'){
    logRowInfo = ': MasterRecordID: '+ rowdata.rowdata.masterRecordID +  ': ChildRecordID: '+ rowdata.rowdata.childRecordID;
    ////console.log(new Date() + ': INFO : rowdata.rowdata.masterRecordID: ' + rowdata.rowdata.masterRecordID);
    ////console.log(new Date() + ': INFO : rowdata.rowdata.childRecordID: ' + rowdata.rowdata.childRecordID);

    let recordLinksResult = await languageRelationParent(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID);
    //logger.info(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    ////console.log(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    return Promise.resolve(recordLinksResult);    
  } else if(rowdata.mode === 'LanguageRelationChild'){
    logRowInfo = ': MasterRecordID: '+ rowdata.rowdata.masterRecordID +  ': ChildRecordID: '+ rowdata.rowdata.childRecordID;
    ////console.log(new Date() + ': INFO : rowdata.rowdata.masterRecordID: ' + rowdata.rowdata.masterRecordID);
    ////console.log(new Date() + ': INFO : rowdata.rowdata.childRecordID: ' + rowdata.rowdata.childRecordID);

    let recordLinksResult = await languageRelationChild(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID);
    //logger.info(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    //console.log(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    return Promise.resolve(recordLinksResult);   }
}