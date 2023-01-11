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
pm2 start aprimo-bosch-import.js
```

## Usage
App is default set to 30 Min Cron and run immediately when you start/restart.

## Important Config Files/Folders
```
./ftp-temp
./logs
```

SFTP Config File './ftp.json'
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
  "client_id": "T8JO0CJM-T8JO",
  "API_URL": "https://boschpowertools-sb1.aprimo.com/api/oauth/create-native-token",
  "Auth_Token": "TmlkaGkuU2hhcm1hOjAyOTQxNDg4ZDNkZjQxZmE4Y2EyMmU2MDAzMjU1ZTZj",
  "BaseURL": "https://boschpowertools-sb1.dam.aprimo.com/api/",
  "GetRecord_URL": "https://boschpowertools-sb1.dam.aprimo.com/api/core/record/",
  "CreateRecord": "https://boschpowertools-sb1.dam.aprimo.com/api/core/records",
  "Upload_Segments_URL": "https://boschpowertools-sb1.aprimo.com/uploads/segments",
  "Upload_URL": "https://boschpowertools-sb1.dam.aprimo.com/api/core/uploads",
  "SearchAsset": "https://boschpowertools-sb1.dam.aprimo.com/api/core/records?filter=FieldName('KBObjectID')=",
  "GetClassification": "https://boschpowertools-sb1.dam.aprimo.com/api/core/classification?namePath=",
  "GetClassificationByName": "https://boschpowertools-sb1.dam.aprimo.com/api/core/classifications?filter=name=",
  "SearchUser": "https://boschpowertools-sb1.aprimo.com/api/users/search",
  "Api_version": "1",
  "sourcePath": "/aprimo/test",
  "targetPath": "./ftp-temp",
  "imgFolderPath": "./ftp-temp/binary/",
  "tempAssetID": "b252a6222b75410599b8af6600af043a",
  "defaultAssetOwner": "90d80b96-a5d5-4564-ad61-af7101215a33"
}
```

API Classification Config File './bosch-classificationlist.json' 
```
{}
```
Note: Data will be auto generated.

## Support
If you find a bug or encounter any issue or have a problem/question with this script please contact bhavinder.singh@gateb.com
