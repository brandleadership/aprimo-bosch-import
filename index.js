const Piscina = require('piscina')
var path = require("path");
let Client = require("ssh2-sftp-client");
const csv = require("csvtojson");
const XLSX = require('xlsx');
var fs = require("fs");
const ftpConfig = JSON.parse(fs.readFileSync("ftp.json"));
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

main = async () => {

    if (fs.existsSync(APR_CREDENTIALS.checkin)) {
        console.log("Start: With CPU:" + APR_CREDENTIALS.worker, new Date());
        //await readExcel();
        await createRelation();
        console.log("End: ", new Date());
    } else {
        console.log("0002");
        //await downloadCSVFromFtp();
        //await JSONtoCheckInData();
        //await readExcel();
        await createRelation();
    }
};

async function readExcel(){
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);
    
    const sheets = file.SheetNames;
    for (let i = 0; i < sheets.length; i++) {
        const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]]);
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
                    await writeExcel([csvData]);
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
            await writeExcel([csvData]);
        }
    }
}

async function createRelation(){
    const file = XLSX.readFile(APR_CREDENTIALS.checkin);    
    const sheets = file.SheetNames;
    for (let i = 0; i < sheets.length; i++) {
        const csvData = XLSX.utils.sheet_to_json(file.Sheets[file.SheetNames[i]]);
        const maserData = csvData.filter((row) => row['MASTER_RECORD'] === 'x' && row['recordID'] != null);
        let index = 0;
        let cpuIndex = 0;
        let poolArray = [];

        for (const maserDataRow of maserData) {
            if (maserDataRow?.status === 'checkin') {
                cpuIndex++;
                csvData[maserDataRow.index].status = 'linked';
                csvData[maserDataRow.index].index = index;
                const childData = csvData.filter((row) => row['OBJ_ID'] === maserDataRow.OBJ_ID && row['recordID'] != null && row['MASTER_RECORD'] != 'x');                
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
  
  try {
    main();
  } catch (error) {
    logger.error(new Date() + ': System Error -- ' + error);
  }
