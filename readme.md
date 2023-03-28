# Aprimo Bosch Import Script

This package provides the way to CSV from FTP and Import values into Aprimo with API.

## Table of Contents
- [Installation](#installation)
- [Usage](#usage)
- [Important Config Files/Folders](#Important Config Files/Folders)
- [Support](#support)

## Installation

To install, use npm v8.19.2:

```
nvm install v18.12.1
nvm use v18.12.1
npm install pm2 -g
npm install
```
Use: node_modules.zip to skip the installation. (Recommendation: Always install Node packages to avoid unseen error.)

## Usage
node index.js &
This command will run the app in the backend. 

## Important Config Files and Folders
```
./ftp-temp
./logs
```

SFTP Config File './ftp.json', SFTP where CSVs are stored. 
```
{
  "host": "52.58.127.25",
  "port": "22",
  "username": "xxxxx",
  "password": "xxxxx"
}
```

API Credentials Config File './aprimo-credentials.json'
```
{
  "client_id": "JROHFIO2-JROH",
  "API_URL": "https://boschpowertools-sb1.aprimo.com/api/oauth/create-native-token",
  "Auth_Token": "dGVzdEFkbWluOmVkNGJjM2MwMzVkNjQxMzRhYjJkZTdjMTRiOGVlOWVl",
  "BaseURL": "https://boschpowertools-sb1.dam.aprimo.com/api/",
  "GetRecord_URL": "https://boschpowertools-sb1.dam.aprimo.com/api/core/record/",
  "CreateRecord": "https://boschpowertools-sb1.dam.aprimo.com/api/core/records",
  "Upload_Segments_URL": "https://boschpowertools-sb1.aprimo.com/uploads/segments",
  "Upload_URL": "https://boschpowertools-sb1.dam.aprimo.com/api/core/uploads",
  "SearchAsset": "https://boschpowertools-sb1.dam.aprimo.com/api/core/records?filter=FieldName('mpe_obj_id')=",
  "GetClassification": "https://boschpowertools-sb1.dam.aprimo.com/api/core/classification?namePath=",
  "GetClassificationByName": "https://boschpowertools-sb1.dam.aprimo.com/api/core/classifications?filter=name=",
  "SearchUser": "https://boschpowertools-sb1.aprimo.com/api/users/search",
  "Api_version": "1",
  "sourcePath": "/PRIMA/outgoing/MAM/aPrimo/CSV Example",
  "targetPath": "./ftp-temp",
  "checkin": "./ftp-temp/checkindata.xlsx",
  "imgFolderPath": "./ftp-temp/binary/",
  "tempAssetID": "a6fb9669d0d04b5eb6d4afb1007e5e5b",  
  "defaultAssetOwner": "90d80b96-a5d5-4564-ad61-af7101215a33",
  "worker": 2,
  "proxyServerInfo":{
    "protocol": "http",
    "host": "xxxx.gateb.com",
    "port": "xxxx",
    "auth": {
      "username": "squid",
      "password": "Qm9vdjRvOkpvdGg0d296"
    } 
  },
  "cronIntv": "0 1 * * *"
}
```

API Classification Config File './bosch-classificationlist.json' 
```
{}
```
Note: Data will be auto generated.

## Support
If you find a bug or encounter any issue or have a problem/question with this script please contact bhavinder.singh@gateb.com
