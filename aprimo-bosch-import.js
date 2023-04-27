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
const classificationlist = require("./bosch-classificationlist");

// Window System Path
//let imgFolderPath = "ftp-temp\\binnery\\";
let API_TOKEN = {
  timeStamp: new Date().getTime() - 480000,
  accessToken: ''
};

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
 * Generating Token
 */
getToken = async () => {
  // Check for 8 Minutes API Token 
  let syncTime = new Date().getTime() - 480000;  
  if(API_TOKEN.timeStamp < syncTime) {
    const resultAssets = await axios.post(APR_CREDENTIALS.API_URL, JSON.stringify('{}'),{
        timeout: 60000,
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
      logger.info(new Date() + ': API Token Generated: ###################################');
      return resp.data;
    })
    .catch(async (err) => {    
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': getToken error -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': getToken error -- ' + JSON.stringify(err));
      }
      var aprToken = await getToken();
      return aprToken;
    });  
    if(resultAssets?.accessToken !== undefined){
      API_TOKEN.timeStamp = new Date().getTime();
      API_TOKEN.accessToken = resultAssets.accessToken;
    }
    return resultAssets;
  } else {
    return API_TOKEN;
  }
};

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

  logger.info(new Date() + ': Start recordLinks API: '+ masterRecordID);
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
        logger.error(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
        console.log(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
        console.log(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
      }  
      return false;
    });
    
    logger.info(new Date() + ': End recordLinks API: '+ masterRecordID);
  return resultAssets;
};



/**
 * Search for The Records in a combination of KBObjectID and Title and Kittelberger ID
 * @param {*} File Name, CSV Row Data, token
 */
searchAsset = async (token, Asset_BINARY_FILENAME, recordsCollection) => {
  ///let filterFileName = Asset_BINARY_FILENAME.replace(/&/g, "%26");
  //filterFileName = filterFileName.replace(/\+/g, "%2b");

  logger.info(new Date() + ': JobID: '+ recordsCollection.JOB_ID + ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' INFO : ###################################');
  logger.info(new Date() + ': JobID: '+ recordsCollection.JOB_ID + ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' INFO : Start Processing Row');
  let queryString = '';
  if(recordsCollection.LV_ID === ''){
    queryString = "'" + recordsCollection.OBJ_ID + "'";
  }else{
    queryString = "'" + recordsCollection.OBJ_ID + "'" + " and FieldName('Kittelberger ID') = '" + recordsCollection.LV_ID + "'";
  }
  

  logger.info(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' INFO : SearchAsset URL: -- ' + APR_CREDENTIALS.SearchAsset + encodeURI(queryString));
  console.log(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID);
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
        logger.info(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' INFO : Records Creating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        //console.log(new Date() +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' INFO : Records Creating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);

        getFieldsResult = await getFields("null", token, recordsCollection);
      } else if (itemsObj.totalCount === 1) {
        logger.info(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' INFO : Records Updating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        //console.log(new Date() +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  +  ' INFO : Records Updating: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
        getFieldsResult = await getFields(itemsObj.items[0].id, token, recordsCollection);
      }else{
        logger.info(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' Error : More Than One Record Found: -- OBJ_ID: ' + recordsCollection.OBJ_ID + ' LV_ID: ' + recordsCollection.LV_ID);
      }
      return getFieldsResult;
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' ERROR : Search Asset API -- ' + JSON.stringify(err.response.data));
        return {'result': 0, 'message': JSON.stringify(err.response.data)};
      } else {
        logger.error(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' ERROR : Search Asset API -- ' + JSON.stringify(err));
        return {'result': 0, 'message': JSON.stringify(err)};
      }
      //console.log(new Date() + ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  + ' ERROR : Search Asset API -- ' + JSON.stringify(err.response.data));
      
    });

    logger.info(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  +  ' INFO : End Processing Row');    
    logger.info(new Date() + ': JobID: '+ recordsCollection.JOB_ID +  ': PID: '+ recordsCollection.OBJ_ID  + '_' + recordsCollection.LV_ID  +  ' INFO : ###################################');
    logger.info(new Date() + ' ');    
  
  return APIResult;
};

/**
 * Search for Classification ID
 * @param {*} Class Name, CSV Row Data, token
 */
searchClassification = async (ClassID, token, data) => {
  let filterClass = '';
  if (typeof ClassID === 'string') {
    filterClass = ClassID.replace(/&/g, "%26");
    filterClass = filterClass.replace(/\+/g, "%2b");
  }

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
      //console.log("resp.data.id:", resp.data.id);
      if (resp.data.id === null) {
        //console.log(new Date() + ": WARNING : Classification Missing -- ", APR_CREDENTIALS.GetClassification + filterClass);
        clogger.warn(new Date() + ': WARNING : Classification Missing -- ' + APR_CREDENTIALS.GetClassification + filterClass);
        return 'null';
      } else {
        classificationlist[ClassID] = resp.data.id;
        await writeClassificationlist();
        return resp.data.id;
      }
    })
    .catch(async (err) => {
      //console.log(new Date() + ": WARNING : Classification Missing -- ", JSON.stringify(err.response.data));
      clogger.warn(new Date() + ': WARNING : Classification Missing URL -- ' + APR_CREDENTIALS.GetClassification + filterClass);
      if(err.response !== undefined && err.response.data !== undefined){
        clogger.warn(new Date() + ': WARNING : ' + JSON.stringify(err.response.data));
      } else {
        clogger.warn(new Date() + ': WARNING : ' + JSON.stringify(err));
      }
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
  //console.log("fileSizeInMegabytes:", fileSizeInMegabytes);
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

    try {
      if(recordsCollection.BINARY_FILENAME === '' && recordsCollection.LV_ID === ''){
        const aprToken = await getToken();
        if(aprToken?.accessToken !== undefined){
            token = aprToken.accessToken;
            APIResult = await createMeta(assetID, recordsCollection, 'null', token);  
        }
      } else {
        const ImageToken = await uploadAsset(token, filename, recordsCollection.JOB_ID);
        //console.log(new Date() + ": INFO : Create Meta:");
        logger.info(new Date() + ': INFO : Create Meta:');

        const aprToken = await getToken();
        if(aprToken?.accessToken !== undefined){
            token = aprToken.accessToken;
            APIResult = await createMeta(assetID, recordsCollection, ImageToken, token);      
        }
      }
    } catch (error) {
      console.log(new Date() + ": Error : Create Meta: "+ error);
      logger.info(new Date() + ': Error : Create Meta: '+ error);
      APIResult = {'result': 0, 'message': error};
    }
  } else {
    try {
      const aprToken = await getToken();
      if(aprToken?.accessToken !== undefined){
          token = aprToken.accessToken;
          APIResult = await createMeta(assetID, recordsCollection, 'null', token);  
      }
    } catch (error) {
      console.log(new Date() + ': PID: '+ assetID + ' Error : Create Meta: ' + error);
      logger.info(new Date() + ': PID: '+ assetID + ' Error : Create Meta: ' + error);
      APIResult = {'result': assetID, 'message': error};
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
        //console.log(new Date() + ': ERROR : tempAssetID Missing --');
        return null;
      }
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
      return null;
    });
  return getFieldsResult;
};

/**
 * 
 * Find fields IDs for updating records. 
 * @param {*} token
 */  
findFieldID = async (fieldName, token) => {
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
        logger.error(new Date() + ': ERROR : Field Not Found --');
        //console.log(new Date() + ': ERROR : tempAssetID Missing --');
        return null;
      }
    })
    .catch(async (err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : getFieldIDs API -- ' + JSON.stringify(err.response.data));
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


  try {
    
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
      case 'AGENCY':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_agency');
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
        break;
      case 'BRAND'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_brand');
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
        break;
      case 'BU': //Classification (Hierarchical)        
        APIResult = await searchClassificationName(tmpKey, token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        
          ObjectID = findObject(tempAssetObj, 'fieldName', 'New_Ownership');
          console.log("ObjectID", ObjectID.length);
          if(ObjectID.length === 0){
            ObjectID = await findFieldID('New_Ownership', token);
          }
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": ClassID,
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }
        break;        
      case 'CONTACT'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_contact');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'DEPT'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'ResponsibleDepartment');
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
      case 'DESC'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_desc');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'DESCRIPTION'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_description');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'DESCRIPTION_POD'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_description_pod');
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
      case 'HEADLINE'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_headline');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;  
      case 'ILABEL':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_ilabel');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'IMG_TYPE': //Classification (Hierarchical)
        
        APIResult = await searchClassificationName(tmpKey, token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_img_type');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": ClassID,
              "languageId": "00000000000000000000000000000000"
            }]
          });  
        }
        // code block
        break;
      case 'IMG_TYPE_HAWERA': //Classification (Hierarchical)
        
        APIResult = await searchClassificationName(tmpKey, token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_img_type_hawera');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": ClassID,
              "languageId": "00000000000000000000000000000000"
            }]
          });
        }
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
      /*case 'LANGUAGE'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'AssetLanguage');
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
        break;*/
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
      case 'ORIG_BE_ID'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_orig_be_id');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'PERSPECTIVE'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_perspective');
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
      case 'PHOTOGRAPHER'://Text
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_photographer');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        // code block
        break;
      case 'PRODUCTION_AGENCY'://Option List
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_production_agency');
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
            ObjectID = findObject(tempAssetObj, 'fieldName', 'Status');
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "values": ClassID,
                "languageId": "00000000000000000000000000000000"
              }]
            });
          }
          // code block
          break;
      case 'SYMBOLIMG_DESCRIPTION'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_symbolimg_description');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
          // code block
          break;
      case 'TITLE'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_title');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
          // code block
          break;
      case 'TRADE_LABEL_AGENCY'://Option List
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_agency');
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
      case 'TRADE_LABEL_BRAND'://Option List
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_brand');
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
      case 'TRADE_LABEL_CONTACT'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_contact');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
          // code block
          break;
      case 'TRADE_LABEL_DEPT'://Option List
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_dept');
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
      case 'TRADE_LABEL_EAN'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_ean');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "value": data[key],
              "languageId": "00000000000000000000000000000000"
            }]
          });
          // code block
          break;
      case 'TRADE_LABEL_KEYWORDS'://Text
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_keywords');
          updateObj.fields.addOrUpdate.push({
            "id": ObjectID[0].id,
            "localizedValues": [{
              "values": [data[key]],
              "languageId": "00000000000000000000000000000000"
            }]
          });
          // code block
          break;
      case 'TRADE_LABEL_PERSPECTIVE'://Option List
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_trade_label_perspective');
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
              let APIResult = await searchClassificationID(lastValue, token, data)
              if (APIResult !== 'null') {
                ClassID.push(APIResult);
              }  
            }            
          }
        }
        
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
            updateObj.fields.addOrUpdate.push({
              "id": ObjectID[0].id,
              "localizedValues": [{
                "value": data[key],
                "languageId": "00000000000000000000000000000000"
              }]
            });
            // code block
            break;
      case 'LTYPE_ID':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_ltype_id');
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
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_ltype_name');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
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
      case 'OBJ_ID':
        ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_obj_id');
        updateObj.fields.addOrUpdate.push({
          "id": ObjectID[0].id,
          "localizedValues": [{
            "value": data[key],
            "languageId": "00000000000000000000000000000000"
          }]
        });
        break;
      case 'ORIGINAL_FILENAME':
        // code block
        break;
      case 'OTYPE_ID':
        APIResult = await searchClassificationID(data[key], token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
        
          ObjectID = findObject(tempAssetObj, 'fieldName', 'mpe_object_type');
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
      case 'OTYPE_NAME':
        // code block
        break;
      case 'SYSTEM_STATUS':
        APIResult = await searchClassificationID('mpe_' + data[key], token, data);
        if (APIResult !== 'null') {
          ClassID.push(APIResult);
          ObjectID = findObject(tempAssetObj, 'fieldName', 'SystemStatus');
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
      //Other Old Mapped Fields
      case 'BINARY_FILENAME':
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
      */
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
      /*
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
      */
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
    //console.log("ClassID: ", ClassID);

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
  //console.log("ClassObj: ", ClassObj);  

  } catch (error) {
    logger.info(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + ' ERROR : META:' + JSON.stringify(error));
    console.log(' ERROR : META:', error);
  }


  //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + ' INFO : Update JSON:' + JSON.stringify(updateObj));
  logger.info(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + ' INFO : Update JSON:' + JSON.stringify(updateObj));
  

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
          logger.info(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' INFO : Record ID: ' + resp.data.id);
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

          return {'result': resp.data.id, 'message': 'RECORD CREATED'};
        } else {
          logger.error(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : GETTING RECORD ID -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
          //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : GETTING RECORD ID -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID: ' + data.OBJ_ID);
          logger.error(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : GETTING RECORD ID -- ' + JSON.stringify(resp));
          //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : GETTING RECORD ID -- ' + JSON.stringify(resp));
          return {'result': 0, 'message': JSON.stringify(resp)};
        }
      })
      .catch((err) => {
        if(err.response !== undefined && err.response.data !== undefined){
          logger.error(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : CREATE RECORD API -- ' + JSON.stringify(err.response.data));        
          return {'result': 0, 'message': JSON.stringify(err.response.data)};
        } else {
          logger.error(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : CREATE RECORD API -- ' + JSON.stringify(err));
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
        logger.info(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' INFO : Record Updated: ' + assetID);
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
        return {'result': assetID, 'message': 'RECORD UPDATED'};
      })
      .catch((err) => {
        logger.error(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : UPDATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID' + data.OBJ_ID);
        //console.log(new Date() + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : UPDATE RECORD API -- LV_ID: ' + data.LV_ID + ' AND OBJ_ID' + data.OBJ_ID);
        if(err.response !== undefined && err.response.data !== undefined){
          logger.error(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : UPDATE RECORD API -- ' + JSON.stringify(err.response.data));
          return {'result': 0, 'message': JSON.stringify(err.response.data)};
        } else {
          logger.error(new Date() + ': JobID: '+ data["JOB_ID"] + ': PID: '+ data["OBJ_ID"] + '_' + data.LV_ID + ' ERROR : UPDATE RECORD API -- ' + JSON.stringify(err));
          return {'result': 0, 'message': JSON.stringify(err)};
        }        
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
  //console.log(new Date() + ': INFO : Search USER ID: ', JSON.stringify(body));
  logger.error(new Date() + ': INFO : Search USER URL: ' + APR_CREDENTIALS.SearchUser);
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
          logger.error(new Date() + ': INFO : USER ID: ', resp.data['_embedded'].user[0].adamUserId);
          //console.log(new Date() + ': INFO : USER ID: ', resp.data['_embedded'].user[0].adamUserId);
          return resp.data['_embedded'].user[0].adamUserId;
        } else {
          logger.error(new Date() + ': ERROR : USER NOT FOUND -- First Name: ' + firstName + ' Last Name: ' + lastName);
          //console.log(new Date() + ': ERROR : USER NOT FOUND -- First Name: ' + firstName + ' Last Name: ' + lastName);
          return '0';
        }
      })
      .catch((err) => {
        logger.error(new Date() + ': ERROR : USER SEARCH API -- First Name: ' + firstName + ' Last Name: ' + lastName);
        //console.log(new Date() + ': ERROR : USER SEARCH API -- First Name: ' + firstName + ' Last Name: ' + lastName);

        if(err.response !== undefined && err.response.data !== undefined){
          logger.error(new Date() + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err.response.data));
        } else {
          logger.error(new Date() + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err));
        }

        //console.log(new Date() + ': ERROR : USER SEARCH API -- ' + JSON.stringify(err.response.data));
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
  ////console.log('filterClass: ', filterClass);
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
        return ObjectID[0].id;
      } else {
        //console.log(new Date() + ': ERROR : Field Definition -- ' + fieldURL);
        logger.error(new Date() + ': ERROR : Field Definition -- ' + fieldURL);
        //console.log(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);
        logger.error(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);

        return 'null';
      }
    })
    .catch(async (err) => {
      //console.log(new Date() + ': ERROR : Field Definition API -- ' + fieldURL);
      //console.log(new Date() + ": ERROR : Field Definition API -- ", JSON.stringify(err.response.data));
      logger.error(new Date() + ': ERROR : Field Definition API -- ' + fieldURL);
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : is ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : Field Definition Column -- ' + keyValue + ' Value ' + fieldValue);
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
  ////console.log("searchClassificationName URL: ", APR_CREDENTIALS.GetClassificationByName + "'" + filterClass + "'");
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
        //console.log("Field Value: ", itemsObj.items[0].id);
        return itemsObj.items[0].id;
      } else {
        logger.error(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        return 'null';
      }
    })
    .catch(async (err) => {
      logger.error(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
      //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
      if(err.response !== undefined && err.response.data !== undefined){
        logger.warn(new Date() + ': ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.warn(new Date() + ': ERROR : is ' + JSON.stringify(err));
      }

      return 'null';
    });
  return resultID;
};

/**
 * 
 * Search for Classificate Name
 * @param {*} ClassID, token, data
 */ 
searchClassificationID = async (ClassID, token, data) => {
  //let filterClass = ClassID.replace(/&/g, "%26");
  //filterClass = filterClass.replace(/\+/g, "%2b");
  ////console.log("searchClassificationName URL: ", APR_CREDENTIALS.GetClassificationByName + "'" + filterClass + "'");
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
        return itemsObj.items[0].id;
      } else {
        logger.error(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
        return 'null';
      }
    })
    .catch(async (err) => {
      logger.error(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
      //console.log(new Date() + ': ERROR : Classification is missing: -- ' + encodeURI(ClassID));
      if(err.response !== undefined && err.response.data !== undefined){
        logger.warn(new Date() + ': ERROR : is ' + JSON.stringify(err.response.data));
      } else {
        logger.warn(new Date() + ': ERROR : is ' + JSON.stringify(err));
      }

      return 'null';
    });
  return resultID;
};
/**
 * Upload file into Aprimo
 * @param {*} token, filename 
 */
async function uploadAsset(token, filename, processPath) {

  let BINARY_FILENAME = filename
  let remotePath = APR_CREDENTIALS.sourcePath + '/'+ processPath + '/binary/' + filename;
  filename = imgFolderPath + filename;
  
  logger.info(new Date() + ': Start Downloading: ' + filename);
  let sftp = new Client();
  await sftp.connect(ftpConfig)
    .then(async () => {      
      await sftp.fastGet(remotePath, filename);
      logger.info(new Date() + ': End Downloading: ' + filename);
    }).catch(e => {
      logger.error(new Date() + ': ERROR : in the FTP Connection -- ' + e);
      //console.log(new Date() + ': ERROR : in the FTP Connection -- ' + e);
    });
    

    if (fs.existsSync(filename) && BINARY_FILENAME !== '') {
      let varFileSize = await getFilesizeInMegabytes(filename);
      //let varFileSizeByte = varFileSize * (1024 * 1024);
      let getMimeType = mime.lookup(filename);
      let APIResult = null;
      if (varFileSize > 1) {


        const aprToken = await getToken();
        if(aprToken?.accessToken !== undefined){
            token = aprToken.accessToken;

            let SegmentURI = await getSegmentURL(filename, token);

            APIResult = await splitFile
              .splitFileBySize(filename, 10000000)
              .then(async (names) => {
                for (let start = 0; start < names.length; start++) {
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
                
                const aprToken = await getToken();
                if(aprToken?.accessToken !== undefined){

                  logger.info(new Date() + ': Start Uploading Chunks: ' + filename);
                  token = aprToken.accessToken;
                  const ImgToken = await commitSegment(SegmentURI, filename, names.length, token);

                  // Delete Main File 
                  fs.unlink(filename, (err) => {
                    if (err){
                      logger.error(new Date() + ': ERROR : File Deletion -- ' + JSON.stringify(err));
                      //console.log(new Date() + ': ERROR : File Deletion -- ' + JSON.stringify(err));    
                    } 
                  });
                  // Delete Segment Files
                  for (let start = 0; start < names.length; start++) {
                    fs.unlink(names[start], (err) => {
                      if (err){
                        logger.error(new Date() + ': ERROR : File Deletion -- ' + JSON.stringify(err));
                        //console.log(new Date() + ': ERROR : File Deletion -- ' + JSON.stringify(err));    
                      } 
                    });  
                  }
                  logger.info(new Date() + ': End Uploading Chunks: ' + filename);
                  return ImgToken;  
                } else {
                  return null;
                }
              })
              .catch((err) => {
                if(err.response !== undefined && err.response.data !== undefined){
                  logger.error(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err.response.data));
                } else {
                  logger.error(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err));
                }
          
                //console.log(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err.response.data));
                return null;
              });
            return APIResult;
        }else{
          return null;
        }
      } else {
        //logger.info(new Date() + ": fileSize is < 20 MB: ");
        logger.info(new Date() + ': Start Uploading: ' + filename);
        let form = new FormData();
        form.append("file", fs.createReadStream(filename), {
          contentType: getMimeType,
          filename: BINARY_FILENAME,
        });

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
                  logger.error(new Date() + ': ERROR : File Deletion -- ' + JSON.stringify(err));
                } 
              });  

            logger.info(new Date() + ': End Uploading: ' + filename);
            return ImgToken;
          })
          .catch((err) => {
            if(err.response !== undefined && err.response.data !== undefined){
              logger.error(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err.response.data));
            } else {
              logger.error(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err));
            }
        
            //console.log(new Date() + ': INFO : uploadAsset API -- ' + JSON.stringify(err.response.data));
            return null;
          });

        return reqUploadImg;
      }



    }else{
      logger.error(new Date() + ': ERROR : File Not Found in the FTP -- ' + filename);
      //console.log(new Date() + ': ERROR : File Not Found in the FTP -- ' + filename);
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
        logger.error(new Date() + ': ERROR : getSegment -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : getSegment -- ' + JSON.stringify(err));
      }

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
      //console.log("Segment Upload Done for:", chunkFileName);
    })
    .catch((err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': ERROR : uploadSegment -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : uploadSegment -- ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : uploadSegment -- ' + JSON.stringify(err.response.data));
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
      //console.log("Image Token===", ImgToken);
      //APIResult = await getFields('null', data, token, ImgToken);
      return ImgToken;
    })
    .catch((err) => {
      if(err.response !== undefined && err.response.data !== undefined){
        logger.error(new Date() + ': ERROR : commitSegment -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': ERROR : commitSegment -- ' + JSON.stringify(err));
      }

      //console.log(new Date() + ': ERROR : commitSegment -- ' + JSON.stringify(err.response.data));

      return false;
    });
  return reqUploadImg;
};

/**
 * languageRelationParent
 * @param {*} masterRecordID, childRecordID, token
 */
languageRelationParent = async (masterRecordID, childRecordID, token) => {
  let tempAssetObj = await getFieldIDs(token);
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
  logger.info(new Date() + ': Start languageRelationParent API: '+ masterRecordID);
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
        logger.error(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
      }
      //console.log(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      return false;
    });
  logger.info(new Date() + ': End languageRelationParent API: '+ masterRecordID);
  return resultAssets;
};

/**
 * languageRelationParent
 * @param {*} masterRecordID, childRecordID, token
 */
languageRelationChild = async (masterRecordID, childRecordID, token) => {
  let tempAssetObj = await getFieldIDs(token);  
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
  logger.info(new Date() + ': Start languageRelationChild API: '+ masterRecordID);
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
        logger.error(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      } else {
        logger.error(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err));
      }
      //console.log(new Date() + ': PID: '+ masterRecordID + ' ERROR : RECORD LINKING API -- ' + JSON.stringify(err.response.data));
      return false;
    });
  logger.info(new Date() + ': End languageRelationChild API: '+ masterRecordID);
  return resultAssets;
};

/**
 * Entry point
 */
module.exports = async (rowdata) => {
  //console.log("Data:", rowdata);
  var aprToken = await getToken();
  if(rowdata.mode === 'createRecords'){
    let RecordID = await searchAsset(aprToken.accessToken, rowdata.rowdata.BINARY_FILENAME, rowdata.rowdata);
    console.log("RecordID: ", RecordID);
    rowdata.recordID = RecordID.result;
    rowdata.message = RecordID.message;
    return Promise.resolve(rowdata);
  } else if(rowdata.mode === 'linkRecords'){
    ////console.log(new Date() + ': INFO : rowdata.rowdata.masterRecordID: ' + rowdata.rowdata.masterRecordID);
    ////console.log(new Date() + ': INFO : rowdata.rowdata.childRecordID: ' + rowdata.rowdata.childRecordID);
    let recordLinksResult = await recordLinks(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID, aprToken.accessToken);
    //logger.info(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    ////console.log(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    return Promise.resolve(recordLinksResult);
  } else if(rowdata.mode === 'LanguageRelationParent'){

    ////console.log(new Date() + ': INFO : rowdata.rowdata.masterRecordID: ' + rowdata.rowdata.masterRecordID);
    ////console.log(new Date() + ': INFO : rowdata.rowdata.childRecordID: ' + rowdata.rowdata.childRecordID);

    let recordLinksResult = await languageRelationParent(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID, aprToken.accessToken);
    //logger.info(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    ////console.log(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    return Promise.resolve(recordLinksResult);    
  } else if(rowdata.mode === 'LanguageRelationChild'){

    ////console.log(new Date() + ': INFO : rowdata.rowdata.masterRecordID: ' + rowdata.rowdata.masterRecordID);
    ////console.log(new Date() + ': INFO : rowdata.rowdata.childRecordID: ' + rowdata.rowdata.childRecordID);

    let recordLinksResult = await languageRelationChild(rowdata.rowdata.masterRecordID, rowdata.rowdata.childRecordID, aprToken.accessToken);
    logger.info(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    //console.log(new Date() + ': INFO : recordLinksResult: ' + recordLinksResult);
    return Promise.resolve(recordLinksResult);   }
}