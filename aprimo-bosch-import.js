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
const axiosRetry = require('axios-retry');
axiosRetry(axios, { retries: 3 });

const db = new JsonDB(new Config("fieldIDs", false, true, '/'));
const dbtoken = new JsonDB(new Config("apitoken", false, true, '/'));
const kMap = new JsonDB(new Config("keymapping", false, true, '/'));
const langMap = new JsonDB(new Config("languagemapping", false, true, '/'));
const templateAsset = new JsonDB(new Config("template", false, true, '/'));
const langAsset = new JsonDB(new Config("languages", false, true, '/'));
const oTypes = new JsonDB(new Config("otypes-mapping", false, true, '/'));
const execShPromise = require("exec-sh").promise;
const maxRetries = 3;
const retryDelay = 1000;
let retries = 0;
let logRowInfo = '';
let dataFlag = true;

// Config file for Aprimo Credentials, API Path, Other Settings
const APR_CREDENTIALS = JSON.parse(fs.readFileSync("aprimo-credentials.json"));
// Asset Type Mapping Files for OTYPE_ID to Asset Type

// Build Proxy URL With or Without Username
var fullProxyURL=APR_CREDENTIALS.proxyServerInfo.protocol+"://"+ APR_CREDENTIALS.proxyServerInfo.host +':'+APR_CREDENTIALS.proxyServerInfo.port;
if(APR_CREDENTIALS.proxyServerInfo.auth.username!="")
{
  fullProxyURL=APR_CREDENTIALS.proxyServerInfo.protocol+"://"+APR_CREDENTIALS.proxyServerInfo.auth.username +":"+ APR_CREDENTIALS.proxyServerInfo.auth.password+"@"+APR_CREDENTIALS.proxyServerInfo.host +':'+APR_CREDENTIALS.proxyServerInfo.port;
}

// sFTP Server Binary Path
let imgFolderPath = APR_CREDENTIALS.imgFolderPath;

// sFTP Credential
const ftpConfig = JSON.parse(fs.readFileSync("ftp.json"));

/**
 * Log Files
 */
// To Store All Errors.
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
// To Store All Classification Errors.
var appClassification = new winston.transports.DailyRotateFile({
  level: 'info',
  filename: './logs/bosch-app-classification-error.log',
  createSymlink: true,
  symlinkName: 'bosch-app-classification-error',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});
// To Store All Information.
var appCombined = new winston.transports.DailyRotateFile({
  name: 'info',
  filename: './logs/bosch-app-combined.log',
  createSymlink: true,
  symlinkName: 'bosch-app-combined.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxSize: '20m'
});
// To Store All Tokens.
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
  // Get Token For API
  let token = await getObjectDefault("/token", "null");
  // Template JSON for Relations
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
    // Add recordIds in children of Template JSON
    body.fields.addOrUpdate[0].localizedValues[0].children.push({
      "recordId": childRecordID[i]
    });
  }

  // API Put Request to Link Master Record ID With Child Records 
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
      } else {
        logger.error(new Date() + logRowInfo + ' LINKING ERROR: recordLinks API -- ' + JSON.stringify(err));
      }  
      return false;
    });
    
  logger.info(new Date() + logRowInfo + ': End recordLinks API: '+ masterRecordID);
  // return back true/false
  return resultAssets;
};



/**
 * Search for The Records in a combination of OBJ_ID, LV_ID and LTYPE_ID
 * @param {*} CSV Row Data
 */
searchAsset = async (recordsCollection) => {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");

  logger.info(new Date() + logRowInfo + ' INFO : ###################################');
  logger.info(new Date() + logRowInfo + ' INFO : Start Processing Row');
  // Build Query String
  let queryString = '';
  if(recordsCollection.LV_ID === '' && recordsCollection.LTYPE_ID === ''){
    // If Both LV_ID and LTYPE_ID Are Blank
    queryString = "'" + recordsCollection.OBJ_ID + "'";
  }else if (recordsCollection.LV_ID === ''){
    // If LV_ID is Blank
    queryString = "'" + recordsCollection.OBJ_ID + "'" + " and FieldName('mpe_ltype_id') = '" + recordsCollection.LTYPE_ID + "'";
  }else{
    // If OBJ_ID And LV_ID Value in the CSV
    queryString = "'" + recordsCollection.OBJ_ID + "'" + " and FieldName('Kittelberger ID') = '" + recordsCollection.LV_ID + "'";
  }  

  // Log Search URL for Reference 
  logger.info(new Date() + logRowInfo + ' INFO : SearchAsset URL: -- ' + APR_CREDENTIALS.SearchAsset + encodeURI(queryString));
  
  // Search Record API Call
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
        // If Total Count Zero Then Record Needs to Create
        logger.info(new Date() + logRowInfo + ' INFO : Records Creating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        getFieldsResult = await getFields("null", recordsCollection);
        await db.save();
        return getFieldsResult;
      } else if (itemsObj.totalCount === 1) {
        // If Total Count One Then Record Needs to Update Meta Information
        logger.info(new Date() + logRowInfo  + ' INFO : Records Updating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        getFieldsResult = await getFields(itemsObj.items[0].id, recordsCollection);
        await db.save();
        return getFieldsResult;
      }else{
        // If More Than One Record Found Then Log in Error
        logger.error(new Date() + logRowInfo  + ' DATA WARNING  : More Than One Record Found: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        return {'result': 0, 'message': 'More Than One Record Found'};
      }      
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ' ERROR : Search Asset API -- ' + JSON.stringify(err.response.data));
        return {'result': 0, 'message': JSON.stringify(err.response.data)};
      } else {
        logger.error(new Date() + logRowInfo  + ' ERROR : Search Asset API -- ' + JSON.stringify(err));
        return {'result': 0, 'message': JSON.stringify(err)};
      }
    });

  logger.info(new Date() + logRowInfo + ' INFO : End Processing Row');
  logger.info(new Date() + logRowInfo + ' INFO : ###################################');
  // Return Result of API, Record ID or Zero
  return APIResult;
};


/**
 * Check File Size
 * @param {*} File Name
 */
getFilesizeInMegabytes = async (filename) => {
  // Get File Stats
  var stats = fs.statSync(filename);
  // Get Size from Stats
  var fileSizeInBytes = stats.size;
  // Convert Into Mega Bytes
  var fileSizeInMegabytes = fileSizeInBytes / (1024 * 1024);
  return fileSizeInMegabytes;
};

/**
 * 
 * Check fields Create/Update. 
 * @param {*} assetID, Row Data
 */  
getFields = async (assetID, recordsCollection) => {
  // Get File Name From CSV Column BINARY_FILENAME 
  let filename = recordsCollection.BINARY_FILENAME;
  let APIResult = 0;
  if (assetID === "null"){
    // Create New Record
    try {
      if(recordsCollection.BINARY_FILENAME === '' && recordsCollection.LV_ID === ''){
            logger.info(new Date() + logRowInfo + ' INFO : Create Meta Start: ');
            // Build Meta Information
            APIResult = await createMeta(assetID, recordsCollection, 'null');
            logger.info(new Date() + logRowInfo + ' INFO : Create Meta End: ');
      } else {
        // Upload File
        const ImageToken = await uploadAsset(filename, recordsCollection.JOB_ID);
        logger.info(new Date() + logRowInfo + ' INFO : Create Meta Start: ');
        // Build Meta Information
        APIResult = await createMeta(assetID, recordsCollection, ImageToken);
        logger.info(new Date() + logRowInfo + ' INFO : Create Meta End: ');
      }
    } catch (error) {
      logger.error(new Date() + logRowInfo + ': ERROR  : Create Meta: '+ error);
      APIResult = {'result': 0, 'message': error};
    }
  } else {
    // Update Record
    try {
      logger.info(new Date() + logRowInfo + ' INFO : Create Meta Start: ');
      // Build Meta Information
      APIResult = await createMeta(assetID, recordsCollection, 'null');
      logger.info(new Date() + logRowInfo + ' INFO : Create Meta End: ');
    } catch (error) {
      logger.info(new Date() + logRowInfo + ' ERROR  : Create Meta: ' + error);
      APIResult = {'result': 0, 'message': error};
    }
  }
  // Return Result of API, Record ID or Zero
  return APIResult;
};

/**
 * 
 * createMeta for updating records. 
 * @param {*} assetID, Row data, ImgToken
 */  
createMeta = async (assetID, data, ImgToken) => {  
  let APIResult = false;
  let dataFlagValue = '';
  // Get Temp Asset From Local DB
  //await templateAsset.reload();
  let tempAssetObj = await templateAsset.getData("/asset");
 
  // Get NewAssetType Aprimo ID from tempAssetObj
  let NewAssetTypeID = findObject(tempAssetObj, 'fieldName', 'NewAssetType');

  // Set Object With Dummy JSON
  let updateObj = {
    tag: "<xml>test tag</xml>",
    classifications: {
      addOrUpdate: []
    },
    fields: {
      addOrUpdate: []
    },
  };
  
  // Check for Uploaded Binary Token
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

  let ClassObj = [];
  let CSORELEASE = [];
  for (var key in data) {
    let ClassID = [];
    let tmpDataValue = data[key];
    // Default Option Value as False
    let optionVal = "False";
    let ObjectID = '';
    
    if (typeof tmpDataValue === 'string') {
      // Replace & With HTML Entities
      tmpDataValue = tmpDataValue.replace(/&/g, "%26");
      // Replace + With HTML Entities
      tmpDataValue = tmpDataValue.replace(/\+/g, "%2b");
    }

    // Skip Loop If The Property Is From Prototype
    if (!data.hasOwnProperty(key)) continue;

    // Check For Blank Value And Key Name "INIT_NAME" Then Set Default Asset Owner
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

    // Skip Loop If Value is Blank
    if (data[key] === null || data[key] === '') continue;

    // Check Key And Build Meta Object 
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);
        }
        break;
      case 'BRAND':// Option List
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'BU': // Classification (Hierarchical)        
        /*
        APIResult = await searchClassificationName(tmpDataValue, data);
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
      case 'CONTACT':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'DEPT':// Option List
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'DESC':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'DESCRIPTION':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'DESCRIPTION_POD':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'FILENAME':
        // Skip Block
        break;
      case 'HEADLINE':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'IMG_TYPE': // Classification (Hierarchical)        
        APIResult = await searchClassificationName(tmpDataValue, key, 'MPE Migration/IMG_TYPE_PT/');
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }            
        }else{
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
        }
        break;
      case 'IMG_TYPE_HAWERA': // Classification (Hierarchical)        
        APIResult = await searchClassificationName(tmpDataValue, key, '');
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
        }else{
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
        }
        break;        
      case 'INIT_NAME':
          // ObjectID = findObject(tempAssetObj, 'fieldName', 'Init Name');
          ObjectID = findObject(tempAssetObj, 'fieldName', 'MPE_AssetOwner');          
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "value": data[key],
                "languageId": "00000000000000000000000000000000"
              }]
            });
            
          /* 
          var firstName = data[key].substring(0, data[key].lastIndexOf(" ") + 1);
          var lastName = data[key].substring(data[key].lastIndexOf(" ") + 1, data[key].length);
  
          APIResult = await searchUser(firstName, lastName);
          if(APIResult !== '0'){
            ObjectID = findObject(tempAssetObj, 'fieldName', 'MPE_AssetOwner');
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APIResult],
                "languageId": "00000000000000000000000000000000"
              }]
            });          
          } else {
            ObjectID = findObject(tempAssetObj, 'fieldName', 'MPE_AssetOwner');
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": [APR_CREDENTIALS.defaultAssetOwner],
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }*/
  
        }else{
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
          // code block
          break;
      case 'KEYWORDS': // Comma Separated Values
	      let KeyWordObj = data[key].split(',').slice(0, 75);
        if (KeyWordObj.length > 0) {
          ObjectID = findObject(tempAssetObj, 'fieldName', 'Keywords');
          if (ObjectID.hasOwnProperty('0')) {
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": KeyWordObj,
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }else{
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
        }
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'ORIG_BE_ID':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'PERSPECTIVE':// Option List
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'PHOTOGRAPHER':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'PRODUCTION_AGENCY':// Option List
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'STATUS':
          APIResult = await searchClassificationName(tmpDataValue, key, '');
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
              dataFlag = false;
              dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

            }
          }else{
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          }
          break;
      case 'SYMBOLIMG_DESCRIPTION':// Text
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'TITLE':// Text
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'TRADE_LABEL_AGENCY':// Option List
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'TRADE_LABEL_BRAND':// Option List
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'TRADE_LABEL_CONTACT':// Text
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'TRADE_LABEL_DEPT':// Option List
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;      
      case 'TRADE_LABEL_EAN':// Text
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'TRADE_LABEL_KEYWORDS':// Text
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'TRADE_LABEL_PERSPECTIVE':// Option List
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'CATEGORY_TREE_IDS':// Text
        if (typeof tmpDataValue === 'string'){
          let str_array = tmpDataValue.split('\\\\');

          for (let splitIndex = 0; splitIndex < str_array.length; splitIndex++) {
            // Trim the excess whitespace.
            let treeIDs = str_array[splitIndex];
            let pieces = treeIDs.split(/[\s\|\|]+/);
            let lastValue = pieces[pieces.length - 1];
            lastValue = lastValue.replace(/^\s*/, "").replace(/\s*$/, "");
            if(lastValue !== null){
              let APIResult = await searchClassificationID(lastValue, key)
              if (APIResult !== 'null') {
                ClassID.push(APIResult);
              }else{
                dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'CATEGORY_TREE_NAMES':// Text
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
              dataFlag = false;
              dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

            }
            break;
      case 'LTYPE_ID':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'LTYPE_NAME':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'LV_ID':// Text
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
          break;
      case 'MASTER_RECORD':
          // Skip Block
          break;
      case 'NAME':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'OBJ_ID':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'ORIGINAL_FILENAME':
        // Skip Block
        break;
      case 'OTYPE_ID':
        APIResult = await searchClassificationID(data[key], key);
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
        }else{
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
        }

        //let AssetTypeKey = findObject(oTypes, 'OTYPE_ID', data[key]);
        let AssetTypeKey = "AssetType_Others";
        if(data['IMG_TYPE'] !== null && data['IMG_TYPE'] !== ''){
          logger.info(new Date() + logRowInfo  + ': DATA INFO : ' + "/oTypes/" + data[key] + "/" + data['IMG_TYPE']);
          AssetTypeKey = await getObjectDefault("/oTypes/" + data[key] + "/" + data['IMG_TYPE'], "AssetType_Others");
          logger.info(new Date() + logRowInfo  + ': DATA INFO : AssetTypeKey: ' + AssetTypeKey);
        } else {
          logger.info(new Date() + logRowInfo  + ': DATA INFO : ' + "/oTypes/" + data[key] + "/0");
          AssetTypeKey = await getObjectDefault("/oTypes/" + data[key] + "/0", "AssetType_Others");
          logger.info(new Date() + logRowInfo  + ': DATA INFO : AssetTypeKey: ' + AssetTypeKey);
        }

        if (NewAssetTypeID.hasOwnProperty('0')) {
          APIResult = await searchClassificationID(AssetTypeKey, key);
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
          } else{
              dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
            }
        }else{
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'OTYPE_NAME':
        // Skip Block
        break;
      case 'SYSTEM_STATUS':
        APIResult = await searchClassificationID('mpe_' + data[key], key);
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
        }else{
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
        }
        break;
      case 'BINARY_FILENAME':
        // Skip Block
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'INIT_DATE':
        let INIT_DATE_VAR = new Date();
        ObjectID = findObject(tempAssetObj, 'fieldName', 'CreationDate');
        if (ObjectID.hasOwnProperty('0')) {
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": INIT_DATE_VAR,
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }else{
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
        // Skip Block
        break;
      case 'DOUBLE_WIDTH':
        // Skip Block
        break;
      case 'HD_OBJECT':
        // Skip Block
        break;
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'AC_MAIN_USAGE':
        // Skip Block
        break;
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'CLIPLISTER_LINKS':
        // Skip Block
        break;
      case 'COLOR_SPACE':
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }     
        break;
      case 'JOB_ID':// Text
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
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
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
                    // Ignore the Value
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
          APIResult = await searchClassificationID('Ownership_' + data['RESPONSIBLE_BUSINESS_UNIT'], key);
        }else{
          APIResult = await searchClassificationID('Ownership_Other', key);
        }
        if (APIResult !== 'null') {
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
              ReleaseResult = await searchClassificationID('ReleaseInfoPublic', key);
            }else if(data["RELEASED"] === '-'){//ReleaseInfoInternal
              ReleaseResult = await searchClassificationID('ReleaseInfoInternal', key);
            }else {//ReleaseInfoRestricted
              ReleaseResult = await searchClassificationID('ReleaseInfoRestricted', key);
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
          }

          }else{
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
        }else{
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

        }
        break;
      case 'LANGUAGE':
        let keyMap = await getObjectDefault("/mapping/"+ data[key], "Null");
        if(keyMap === 'Null'){
          APIResult = await searchClassificationID('Language_' + data[key], key);
        }else{
          APIResult = await searchClassificationID(keyMap, key);
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
            dataFlag = false;
            dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

          }
        }
        break;
      case 'LANGUAGES':
        let tmpString = data[key];
        if (typeof tmpString === 'string') {
          let strRegex = /\((.*?)\)/gm;

          tmpString = tmpString.replace(/[\r\n]/g, "");
          let strMatches = tmpString.match(strRegex);
          if (strMatches !== null) {
            let strValues = strMatches.map(strMatch => strMatch.slice(1, -1));
            let mpeHeadlineArray = [];
            let mpeSubHeadlineArray = [];
            let mpeURLArray = [];
            for (let strValuesIndex = 0; strValuesIndex < strValues.length; strValuesIndex++) {
              if (typeof strValues[strValuesIndex] === 'string') {
                let langArray = strValues[strValuesIndex].split(',');
                if (langArray.hasOwnProperty('0')) {
                  //Get Language ID
                  let getLanguageId = await GetLanguageID(langArray[0]); //"c2bd4f9bbb954bcb80c31e924c9c26dc";
                  if (langArray.hasOwnProperty('1')) {
                    if (langArray[1].trim().length > 0) {
                      mpeHeadlineArray.push({
                        "value": langArray[1],
                        "languageId": getLanguageId,
                      });
                    }
                  }
                  if (langArray.hasOwnProperty('2')) {
                    if (langArray[2].trim().length > 0) {
                      mpeSubHeadlineArray.push({
                        "value": langArray[2],
                        "languageId": getLanguageId,
                      });
                    }
                  }
                  if (langArray.hasOwnProperty('3')) {

                    if (langArray[3].trim().length > 0) {
                      mpeURLArray.push({
                        "value": langArray[3],
                        "languageId": getLanguageId,
                      });
                    }
                  }
                }
              }
            }

            if (mpeHeadlineArray.hasOwnProperty('0')) {
              ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_headline');
              if (ObjectID.hasOwnProperty('0')) {
                updateObj.fields.addOrUpdate.push({
                  "id": ObjectID[0].id,
                  "localizedValues": mpeHeadlineArray
                });
              }
              logger.info(new Date() + logRowInfo + ': DATA Languages: mpe_headline: ' + JSON.stringify(mpeHeadlineArray));
            } else {
              logger.info(new Date() + logRowInfo + ': DATA WARNING Languages : mpe_headline: ' + JSON.stringify(mpeHeadlineArray));
            }

            if (mpeSubHeadlineArray.hasOwnProperty('0')) {
              ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_subheadline');
              if (ObjectID.hasOwnProperty('0')) {
                updateObj.fields.addOrUpdate.push({
                  "id": ObjectID[0].id,
                  "localizedValues": mpeSubHeadlineArray
                });
              }
              logger.info(new Date() + logRowInfo + ': DATA Languages: mpe_subheadline: ' + JSON.stringify(mpeSubHeadlineArray));
            } else {
              logger.info(new Date() + logRowInfo + ': DATA WARNING Languages: mpe_subheadline: ' + JSON.stringify(mpeSubHeadlineArray));
            }

            if (mpeURLArray.hasOwnProperty('0')) {
              ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_URL');
              if (ObjectID.hasOwnProperty('0')) {
                updateObj.fields.addOrUpdate.push({
                  "id": ObjectID[0].id,
                  "localizedValues": mpeURLArray
                });
              }
              logger.info(new Date() + logRowInfo + ': DATA Languages: mpe_URL: ' + JSON.stringify(mpeURLArray));
            } else {
              logger.info(new Date() + logRowInfo + ': DATA WARNING Languages: mpe_URL: ' + JSON.stringify(mpeURLArray));
            }


          } else {
            logger.info(new Date() + logRowInfo + ': DATA Languages: ' + tmpString);
          }
        }else{
          dataFlag = false;
          dataFlagValue = ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key];
          logger.error(new Date() + logRowInfo  + ': DATA ERROR : Meta Key: ' + key + ' Value: ' + data[key]);

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

  /*
  if((data['BINARY_FILENAME'] === null || data['BINARY_FILENAME'] === '') && (data['TITLE'] !== null || data['TITLE'] !== '')){
    ObjectID = findObject(tempAssetObj, 'fieldName', 'Title');
    console.log("BINARY_FILENAME 002: ", ObjectID);
    if (ObjectID.hasOwnProperty('0')) {
      updateObj.fields.addOrUpdate.push({
        "id": ObjectID[0].id,
        "localizedValues": [{
          "value": data['TITLE'],
          "languageId": "00000000000000000000000000000000"
        }]
      });
    }
  }
  */

  //Security Authorized Code Start
  if (CSORELEASE.length > 0) {
    let CSOArray = [];
    let AuthorizedOther = await searchClassificationID('Authorized_Other', 'CSORELEASE_Other');
    
    for (let cs = 0; cs < CSORELEASE.length; cs++) {
      APIResult = await searchClassificationID('Authorized_' + CSORELEASE[cs], 'CSORELEASE_' + CSORELEASE[cs]);
      if (APIResult !== 'null') {
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
  // Add Data In Object
  for (let c = 0; c < ClassObj.length; c++) {
    updateObj.classifications.addOrUpdate.push({
      "id": ClassObj[c],
      "sortIndex": c
    });
  }

  // Log Build Object Json
  logger.info(new Date() + logRowInfo + ' INFO : Update JSON:' + JSON.stringify(updateObj));
  
  // Get Token For API
  let token = await getObjectDefault("/token", "null");

  if (assetID === "null") {
    // Create Record API
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
            return {'result': 0, 'message': 'RECORD CREATED WITH DATA ERROR ' + dataFlagValue};
          }          
        } else {
          logger.error(new Date() + logRowInfo + ' ERROR : GETTING RECORD ID -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
          logger.error(new Date() + logRowInfo + ' ERROR : GETTING RECORD ID -- ' + JSON.stringify(resp));
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
      });
    // Return Result of API, Record ID or Zero
    return reqCreatRequest;
  } else {
    // Update Record API
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
        });

        // Return Result of API, Record ID or Zero        
        if(dataFlag){
          return {'result': assetID, 'message': 'RECORD UPDATED'};
        }else{
          return {'result': 0, 'message': 'RECORD UPDATED WITH DATA ERROR' + dataFlagValue};
        }
      })
      .catch((err) => {
        logger.error(new Date() + logRowInfo + ' ERROR : UPDATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID' + data.OBJ_ID + ' Asset ID: ' + assetID);
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
  // Get Token For API  
  let token = await getObjectDefault("/token", "null");
  // Template JSON
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
  logger.info(new Date() + logRowInfo + ': INFO : Search USER URL: ' + APR_CREDENTIALS.SearchUser);
  // API Search User
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
          return resp.data['_embedded'].user[0].adamUserId;
        } else {
          logger.info(new Date() + logRowInfo + ': WARNING : USER NOT FOUND -- First Name: ' + firstName + ' Last Name: ' + lastName);
          return '0';
        }
      })
      .catch((err) => {
        logger.error(new Date() + logRowInfo + ': ERROR : USER SEARCH API -- First Name: ' + firstName + ' Last Name: ' + lastName);

        if(err.response !== undefined && err.response.data !== undefined){
          logger.error(new Date() + logRowInfo + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err.response.data));
        } else {
          logger.error(new Date() + logRowInfo + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err));
        }

        return '0';
      });
    // Return Result of API, User ID or Zero
    return reqCreatRequest;
};

/**
 * 
 * Get GetLanguageID
 * @param {*} token, fieldValue, keyValue
 */ 

GetLanguageID = async (langValue) => {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");
  // Get Language Key From Local DB
  let langKey = await getObjectDefault("/languagemapping/"+langValue, "ignore");
  // Get Language Asset From Local DB
  //await langAsset.reload();
  let tempLangAsset = await langAsset.getData("/asset");
  let LangID = findObject(tempLangAsset, 'culture', langKey);
  if (LangID.hasOwnProperty('0')) {
    return LangID[0].id
  }else{
    // Fall Back to English
    logger.info(new Date() + logRowInfo + ': DATA WARNING GetLanguageID -- ' + langValue);
    return tempLangAsset[0].id;
  }
};


/**
 * 
 * Get Template Field for definition
 * @param {*} fieldURL, fieldValue, keyValue
 */ 
getfielddefinitionID = async (fieldURL, fieldValue, keyValue) => {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");
  // Get Field ID From Local DB
  let fieldData = await getObjectDefault("/fieldIDs/"+ keyValue + "/" + fieldValue, "null");
  
  if (fieldData === 'null') {  
  // Get Field ID From API
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
      ObjectID = findObject(resp.data.items, 'label', fieldValue);
      if (ObjectID.hasOwnProperty('0')) {
        await db.push("/fieldIDs/"+ keyValue + "/" +fieldValue, ObjectID[0].id);
        return ObjectID[0].id;
      } else {
        logger.error(new Date() + logRowInfo + ': OPTION LIST ERROR : Field Definition -- ' + fieldURL);
        logger.error(new Date() + logRowInfo + ': OPTION LIST ERROR : Field Definition Key: ' + keyValue + ' Value: ' + fieldValue);
        dataFlag = false;
        return 'null';
      }
    })
    .catch(async (err) => {
      logger.error(new Date() + logRowInfo + ': API ERROR : Field Definition API -- ' + fieldURL);
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': API ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': API ERROR : is ' + JSON.stringify(err));
      }

      logger.error(new Date() + logRowInfo + ': API ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);
      dataFlag = false;
      return 'null';
    });
    // Return Field ID From API
    return resultID;
  } else {
    // Return Field ID From Local DB
    return fieldData;
  }
};

getObjectDefault = async(key, defval) => {
  let data = defval;
  try {
    if(key === '/token'){
      await dbtoken.reload();
      data = await dbtoken.getData(key);
    } else if (key.includes('/mapping')){
      //await kMap.reload();
      data = await kMap.getData(key);
    } else if (key.includes('/languagemapping')){
      //await langMap.reload();
      data = await langMap.getData(key);
    } else if (key.includes('/oTypes')){
      //await langMap.reload();
      data = await oTypes.getData(key);
    } else {
      //await dbtoken.reload();
      data = await db.getData(key);
    }
  } catch (innerError) {
    if(innerError.message.includes("find dataPath")){
      return data;
    }else if(innerError.message.includes("Load Database")){
      // Retry If Fail to Load Local Database
      if (retries < maxRetries) {
        retries++;
        logger.info(new Date() + logRowInfo + ' DATABASE Retrying: ' + retries);
        data = await getObjectDefault(key, defval);
        return data;
      } else {
        logger.error(new Date() + logRowInfo + ' DATABASE ERROR : key: ' + key + ' val: ' + defval + ' Error: ' + innerError.message);
        logger.info(new Date() + logRowInfo + ' DATABASE Max retries exceeded. Unable to load database. ');
        fs.unlink('./fieldIDs.json', (err) => {
          if (err){
            logger.error(new Date() + ' : ERROR IN RESET LOCAL DB : ');
          }
        });
        return data;
      }
    }
  }
  // Return Value
  return data;
};

/**
 * 
 * Search for Classification Name
 * @param {*} ClassID, Key, ClassPath
 */ 
searchClassificationName = async (ClassID, key, ClassPath) => {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");
  let ClassQuery = APR_CREDENTIALS.GetClassificationByName;
  if(key === 'IMG_TYPE' && !ClassID.includes('/')){
    ClassQuery = ClassQuery + "'" + encodeURI(ClassID) + "' and namePath='" + ClassPath + ClassID + "'";
  }else{
    ClassQuery = ClassQuery + "'" + encodeURI(ClassID) + "'"; 
  }

  // Get Value From Local DB
  let fieldData = await getObjectDefault("/fieldIDs/"+ ClassPath + ClassID, "null");
  logger.info(new Date() + logRowInfo + ': searchClassificationName ' + ClassQuery);
  if (fieldData === 'null') {
  // Get Value From API
  let resultID = await axios
    .get(ClassQuery, {
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
        // Save Value In Local DB
        await db.push("/fieldIDs/"+ClassPath+ClassID, itemsObj.items[0].id);
        return itemsObj.items[0].id;
      } else if (itemsObj.totalCount > 1) {
        clogger.info(new Date() + logRowInfo + ': DATA WARNING : Classification Found More Than One: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        logger.error(new Date() + logRowInfo + ': DATA WARNING : Classification Found More Than One: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        dataFlag = false;
        return 'null';
      } else {
        clogger.info(new Date() + logRowInfo + ': DATA ERROR : Classification Name Is Missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        logger.info(new Date() + logRowInfo + ': DATA ERROR : Classification Name Is Missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        dataFlag = false;
        return 'null';
      }
    })
    .catch(async (err) => {
      clogger.info(new Date() + logRowInfo + ': Classification API ERROR : Classification Name Is Missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
      logger.error(new Date() + logRowInfo + ': Classification API ERROR : Classification Name Is Missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
      if(err.response !== undefined && err.response.data !== undefined){
        logger.warn(new Date() + logRowInfo + ': Classification API ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.warn(new Date() + logRowInfo + ': Classification API ERROR : is ' + JSON.stringify(err));
      }
      dataFlag = false;
      return 'null';
    });
    // Return Result From API
    return resultID;  
  } else {
    // Resturn Result From Local DB
    return fieldData;
  }
};

/**
 * 
 * Search for Classification ID
 * @param {*} ClassID, Key
 */ 
searchClassificationID = async (ClassID, key) => {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");
  let fieldData = await getObjectDefault("/fieldIDs/"+ ClassID, "null");

  if (fieldData === 'null') {
  // Get Value From API
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
        // Save Value In Local DB
        await db.push("/fieldIDs/"+ClassID, itemsObj.items[0].id);
        return itemsObj.items[0].id;
      } else if (itemsObj.totalCount > 1) {
        clogger.info(new Date() + logRowInfo + ': DATA WARNING : Classification ID Found More Than One: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        logger.error(new Date() + logRowInfo + ': DATA WARNING : Classification ID Found More Than One: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        dataFlag = false;
        return 'null';
      } else {
        clogger.info(new Date() + logRowInfo + ': DATA ERROR : Classification ID Is Missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        logger.error(new Date() + logRowInfo + ': DATA ERROR : Classification ID Is Missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
        dataFlag = false;
        return 'null';
      }
    })
    .catch(async (err) => {
      logger.error(new Date() + logRowInfo + ': API ERROR : Classification ID Is Missing: -- Key: ' + key + ' Value: ' + encodeURI(ClassID));
      if(err.response !== undefined && err.response.data !== undefined){
        logger.warn(new Date() + logRowInfo + ': API ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.warn(new Date() + logRowInfo + ': API ERROR : is ' + JSON.stringify(err));
      }
      dataFlag = false;
      return 'null';
    });
    // Return Result From API
    return resultID;
  } else {
    // Return Result From Local DB
    return fieldData;
  }
};

/**
 * Connect FTP With Retry Option
 * @param {*} filename 
 */
async function connectFtpWithRetry(sftpRetry, config, retries, remotePath, filename) {
  return sftpRetry.connect(config)
    .then(async () => {
      await sftpRetry.fastGet(remotePath, filename);
      logger.info(new Date() + logRowInfo + ': End Downloading: ' + filename);
    })
    .catch(async (err) => {
      logger.error(new Date() + logRowInfo + ': FTP ERROR : Error connecting to SSH server: -- ' + err.message);
      if (retries > 0) {
        logger.info(new Date() + logRowInfo + ': Retrying FTP Connection... : ' + retries);
        const nextRetry = retries - 1;

        // Delay Before Retrying
        return new Promise(resolve => setTimeout(resolve, 4000))
          .then(() => connectFtpWithRetry(sftpRetry, config, nextRetry, remotePath, filename));
      } else {
        logger.error(new Date() + logRowInfo + ': FTP ERROR : Connection retries exhausted. Cannot connect to SSH server: -- ' + err.message);
        return err;
      }
    });
}

/***
 * Get Segment URL For Big File From Uploading In Chunks
 */
getUploadTokenAndURL = async (filename) => {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");

  let body = {
    fileName: path.basename(filename)
  };
  // API CALL
  const resultSegmentURL = await axios
    .post(APR_CREDENTIALS.MainURL + 'uploads', JSON.stringify(body), {
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
      return res.data;
    })
    .catch((err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': API ERROR : getUploadTokenAndURL -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': API ERROR : getUploadTokenAndURL -- ' + JSON.stringify(err));
      }
      dataFlag = false;
    });
  // Return Segment URL
  return resultSegmentURL;
};

async function runAzCopyCommand(orgFileToUpload, sasUrl) {
  let out;
  const azCopyCommand = `azcopy copy "${orgFileToUpload}" "${sasUrl}"`;
  console.log("azCopyCommand", azCopyCommand);
  try {
    out = await execShPromise(azCopyCommand, true);
    logger.info(new Date() + logRowInfo + ': runAzCopyCommand -- Stdout: ' + out.stdout);
    logger.info(new Date() + logRowInfo + ': runAzCopyCommand -- Stderr: ' + out.stderr);
    return true;
  } catch (e) {
    logger.error(new Date() + logRowInfo + ': runAzCopyCommand -- Error: ' + e);
    logger.error(new Date() + logRowInfo + ': runAzCopyCommand -- Stderr: ' + e.stderr);
    logger.error(new Date() + logRowInfo + ': runAzCopyCommand -- Stdout: ' + e.stdout);
    return false;
  }
}

/**
 * Upload File Into Aprimo
 * @param {*} filename 
 */
async function uploadAsset(filename, processPath) {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");

  let BINARY_FILENAME = filename
  let remotePath = APR_CREDENTIALS.sourcePath + '/'+ processPath + '/binary/' + filename;
  filename = imgFolderPath + filename;
  
  logger.info(new Date() + logRowInfo + ': Start Downloading: ' + filename);
  let sftp = new Client();
  await connectFtpWithRetry(sftp, ftpConfig, 5, remotePath, filename)
  .catch((err) => {
    dataFlag = false;
    logger.error(new Date() + logRowInfo + ': FTP ERROR : in the FTP Connection -- ' + err.message);
  });
  await sftp.end();

  /*
  await sftp.connect(ftpConfig)
    .then(async () => {      
      await sftp.fastGet(remotePath, filename);
      logger.info(new Date() + logRowInfo + ': End Downloading: ' + filename);
    }).catch(e => {
      logger.error(new Date() + logRowInfo + ': FTP ERROR : in the FTP Connection -- ' + e);
      dataFlag = false;
      //console.log(new Date() + ': ERROR : in the FTP Connection -- ' + e);
    });  
  */
  if (fs.existsSync(filename) && BINARY_FILENAME !== '') {
    let blobResult = await getUploadTokenAndURL(filename);
    if (blobResult.hasOwnProperty('sasUrl')) {
      let AzJob = await runAzCopyCommand(filename, blobResult.sasUrl);
      // Delete Main File
      fs.unlink(filename, (err) => {
        if (err){
          logger.info(new Date() + logRowInfo + ': WARNING : File Deletion -- ' + JSON.stringify(err));
        } 
      });
      if(AzJob){
        console.log("blobResult.token: ", blobResult.token);
        return blobResult.token;
      }else{
        logger.error(new Date() + logRowInfo + ': API ERROR : Upload API -- runAzCopyCommand');
        return null;
      }
    }else{
      logger.error(new Date() + logRowInfo + ': API ERROR : Upload API -- sasUrl');
      return null;
    }
/*
    // Get File Size
    let varFileSize = await getFilesizeInMegabytes(filename);
    // Get Mime Type
    let getMimeType = mime.lookup(filename);
    let APIResult = null;
    // 0.9 MB Set To Avoid API Server Error 413 Request Entity Too Large
    if (varFileSize > 0.9) {
      // Get Segment URL 
      let SegmentURI = await getSegmentURL(filename);
      // Split File Into 10 MB
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
              logger.info(new Date() + logRowInfo + ': WARNING : File Deletion -- ' + JSON.stringify(err));
            } 
          });
          // Delete Segment Files
          for (let start = 0; start < names.length; start++) {
            fs.unlink(names[start], (err) => {
              if (err){
                logger.info(new Date() + logRowInfo + ': WARNING : File Deletion -- ' + JSON.stringify(err));
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
          return null;
        });
      return APIResult;
    } else {
      // File Less Than 1 MB
      logger.info(new Date() + logRowInfo + ': Start Uploading: ' + filename);
      let form = new FormData();
      form.append("file", fs.createReadStream(filename), {
        contentType: getMimeType,
        filename: BINARY_FILENAME,
      });

      // Get Token For API
      token = await getObjectDefault("/token", "null");    
      let reqUploadImg = await axios
        .post(APR_CREDENTIALS.Upload_URL, form, {
          proxy: false,
          httpsAgent: new HttpsProxyAgent(fullProxyURL),
          headers: {
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
              logger.info(new Date() + logRowInfo + ': WARNING : File Deletion -- ' + JSON.stringify(err));
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
          return null;
        });
      return reqUploadImg;
    }
*/







  }else{
    logger.error(new Date() + logRowInfo + ': FTP ERROR : File Not Found in the FTP -- ' + filename);
  }
}

/***
 * Get Segment URL For Big File From Uploading In Chunks
 */
getSegmentURL = async (filename) => {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");

  let body = {
    filename: path.basename(filename)
  };
  // API CALL
  const resultSegmentURL = await axios
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
    });
  // Return Segment URL
  return resultSegmentURL;
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
  // Get Token For API
  let token = await getObjectDefault("/token", "null");
  // Create Form Data
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
    })
    .catch((err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + logRowInfo + ': API ERROR : uploadSegment -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + logRowInfo + ': API ERROR : uploadSegment -- ' + JSON.stringify(err));
      }
      dataFlag = false;
    });
    // No Return 
};

/**
 * commitSegment
 */
commitSegment = async (SegmentURI, filename, segmentcount) => {
  // Get Token For API
  let token = await getObjectDefault("/token", "null");

  let body = {
    filename: path.basename(filename),
    segmentcount: segmentcount,
  };
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
  // Get Temp Asset From Local DB
  //await templateAsset.reload();
  let tempAssetObj = await templateAsset.getData("/asset");

  let ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_language_relation');
  if(ObjectID[0].id === null){
    // Fall Back
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
  logger.info(new Date() + logRowInfo + ': Start languageRelationParent API: '+ masterRecordID);
  // Get Token For API
  let token = await getObjectDefault("/token", "null");
  const resultAPI = await axios.put(APR_CREDENTIALS.GetRecord_URL  + masterRecordID,
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
      return false;
    });
  logger.info(new Date() + logRowInfo + ': End languageRelationParent API: '+ masterRecordID);
  // Return True/False
  return resultAPI;
};

/**
 * languageRelationParent
 * @param {*} masterRecordID, childRecordID
 */
languageRelationChild = async (masterRecordID, childRecordID) => {
    //await templateAsset.reload();
    let tempAssetObj = await templateAsset.getData("/asset");

    let ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_language_relation');
    if(ObjectID[0].id === null){
      // Fall Back
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

    // Get Token For API
    let token = await getObjectDefault("/token", "null");
    logger.info(new Date() + logRowInfo + ': Start languageRelationChild API: '+ masterRecordID);
    const resultAPI = await axios.put(APR_CREDENTIALS.GetRecord_URL  + masterRecordID,
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
        return false;
      });
    logger.info(new Date() + logRowInfo + ': End languageRelationChild API: '+ masterRecordID);
    // Return True/False
    return resultAPI;
};

/**
 * Entry point
 */
module.exports = async (rowdata) => {
  retries = 0;
  dataFlag = true;
  if(rowdata.mode === 'createRecords'){
    logRowInfo = ' : PID: ' + process.pid + ' : JobID: '+ rowdata.rowdata["JOB_ID"] +  ': OBJ_ID: '+ rowdata.rowdata["OBJ_ID"]  + '_' + rowdata.rowdata["LV_ID"];
    let timeStampStart = new Date();
    let RecordID = await searchAsset(rowdata.rowdata);
    let timeStampEnd = new Date();
    rowdata.recordID = RecordID.result;
    rowdata.startTime = timeStampStart.toLocaleString();
    rowdata.endTime = timeStampEnd.toLocaleString();
    rowdata.message = RecordID.message;
    return Promise.resolve(rowdata);
  } else if(rowdata.mode === 'linkRecords'){
    logRowInfo = ' : PID: ' + process.pid + ' : JobID: '+ rowdata.rowdata.masterData["JOB_ID"] +  ': OBJ_ID: '+ rowdata.rowdata.masterData["OBJ_ID"]  + '_' + rowdata.rowdata.masterData["LV_ID"] +  ' : MasterRecordID: '+ rowdata.rowdata.masterRecordID +  ': ChildRecordID: '+ rowdata.rowdata.childRecordID;
    let recordLinksResult = await recordLinks(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID);
    return Promise.resolve(recordLinksResult);
  } else if(rowdata.mode === 'LanguageRelationParent'){    
    logRowInfo = ' : PID: ' + process.pid + ' : JobID: '+ rowdata.rowdata.masterData["JOB_ID"] +  ': OBJ_ID: '+ rowdata.rowdata.masterData["OBJ_ID"]  + '_' + rowdata.rowdata.masterData["LV_ID"] +  ' : MasterRecordID: '+ rowdata.rowdata.masterRecordID +  ': ChildRecordID: '+ rowdata.rowdata.childRecordID;
    let recordLinksResult = await languageRelationParent(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID);
    return Promise.resolve(recordLinksResult);    
  } else if(rowdata.mode === 'LanguageRelationChild'){
    logRowInfo = ' : PID: ' + process.pid + ' : JobID: '+ rowdata.rowdata.masterData["JOB_ID"] +  ': OBJ_ID: '+ rowdata.rowdata.masterData["OBJ_ID"]  + '_' + rowdata.rowdata.masterData["LV_ID"] +  ' : MasterRecordID: '+ rowdata.rowdata.masterRecordID +  ': ChildRecordID: '+ rowdata.rowdata.childRecordID;
    let recordLinksResult = await languageRelationChild(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID);
    return Promise.resolve(recordLinksResult);
  }
}