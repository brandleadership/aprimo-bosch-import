#!/bin/bash
#!/usr/bin/sh
#/home/ubuntu/.nvm/versions/node/v18.13.0/bin/node /home/ubuntu/aprimo-bosch/bosch-import-index.js >> /home/ubuntu/aprimo-bosch/error.log
cd /home/ubuntu/aprimo-bosch/


if pgrep "node" > /dev/null
then
    echo "Node.js application is running." >> error.log
    /home/ubuntu/.nvm/versions/node/v18.13.0/bin/node bosch-import-index.js >> error.log  &
else
    echo "No Node.js application is running. Deleting signature.info file and restarting Node.js." >> error.log
    rm -f signature.info
        /home/ubuntu/.nvm/versions/node/v18.13.0/bin/node bosch-import-index.js >> error.log  &
fi

