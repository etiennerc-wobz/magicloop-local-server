const express = require('express');
const path = require('path');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const https = require('https');
const stripe = require('stripe')('sk_test_51KNzhNBx3mhjsHyvVriXOtqBIweE5k9FVjQRhfWyA1kG5Ca0tATKlAfbmNZt9wlPgMGtA02Kb01IZ0qZ6wbYYY3j00KqGxYJoG');

const app = express();
const port = 443; // HTTPS port

// Middleware setup
app.use(express.urlencoded({ extended: true })); 
app.use(express.static(__dirname));
app.use(express.json()); 
app.use(cors());

// Databases setup
const cupsDB = new sqlite3.Database('./cups.db');
const paymentsDB = new sqlite3.Database('./payments.db');

// Read the key and certificate files
const privateKey = fs.readFileSync('./key.pem', 'utf8');
const certificate = fs.readFileSync('./cert.pem', 'utf8');

const credentials = { key: privateKey, cert: certificate };

// SSE clients storage
let clients = {
    transaction1: [],
    transaction2: [],
    transaction3: []
};

// Utility functions
function sendOrderToClients(data, clients) {
    const order = [
        { name: "Gobelet", quantity: parseInt(data[0]) + parseInt(data[1]) + parseInt(data[2]) },
        { name: "Blonde Ninkasi 50cl", quantity: parseInt(data[0]) },
        { name: "Brune Ninkasi 50cl", quantity: parseInt(data[1]) },
        { name: "Coca-Coca Light 50cl", quantity: parseInt(data[2]) }
    ].filter(item => item.quantity !== 0);

    const dataObj = { transaction_id: "sample-transaction-id" + Math.floor(Math.random() * 1000), order };
    const jsonData = JSON.stringify(dataObj);
    clients.forEach(clientRes => {
        console.log("Sending:", jsonData);
        clientRes.write(`data: ${jsonData}\n\n`);
    });

    const status = 'au bar';
    const sql = `INSERT INTO payments(transaction_id, amount_reserved, status) VALUES(?, ?, ?)`;

    paymentsDB.run(sql, [dataObj.transaction_id, dataObj.order[0].quantity * 2, status], function(err) {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        console.log(`Payment was added to the table: ${this.lastID}`);
    });
}

function handlePostRequest(req, res, clients) {
    console.log('Received a POST request'); 
    const data = req.body.data.split('-');
    sendOrderToClients(data, clients);
    res.sendStatus(200);
}

function handleSSERequest(req, res, clientsKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients[clientsKey].push(res);

    res.on('close', () => {
        clients[clientsKey] = clients[clientsKey].filter(clientRes => clientRes !== res);
    });
}

// POST routes for transactions
app.post('/get-transaction1', (req, res) => handlePostRequest(req, res, clients.transaction1));
app.post('/get-transaction2', (req, res) => handlePostRequest(req, res, clients.transaction2));
app.post('/get-transaction3', (req, res) => handlePostRequest(req, res, clients.transaction3));

// GET routes for SSE
app.get('/get-transaction1', (req, res) => handleSSERequest(req, res, 'transaction1'));
app.get('/get-transaction2', (req, res) => handleSSERequest(req, res, 'transaction2'));
app.get('/get-transaction3', (req, res) => handleSSERequest(req, res, 'transaction3'));

// Serve the main interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'interfaceOrder.html'));
});

// Serve the database interface
app.get('/db', (req, res) => {
    res.sendFile(path.join(__dirname, 'databasePage.html'));
});

// Handle cups rental (start-location)
app.post('/link_payment_to_cup', (req, res) => {
    const data = req.body;
    const status = 'en cours';
    const select_sql = `SELECT cup_id FROM cups WHERE cup_id = ?`;
    const insert_sql = `INSERT INTO cups(transaction_id, cup_id, status) VALUES(?, ?, ?)`;
    const update_sql = `UPDATE payments SET status = ? WHERE transaction_id = ?`;

    data.cup_id_list.forEach(cup_id => {
        cupsDB.get(select_sql, [cup_id], (err, row) => {
            if (err) {
                console.error(err.message);
                return;
            }
            if (row) {
                console.log(`cup_id ${cup_id} is already in use`);
            } else {
                cupsDB.run(insert_sql, [data.transaction_id, cup_id, status], function(err) {
                    if (err) {
                        console.error(err.message);
                        return;
                    }
                    console.log(`Cup was added to the table: ${this.lastID}`);
                });
            }
        });
    });

    paymentsDB.run(update_sql, [status, data.transaction_id], function(err) {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        console.log(`Payment status was updated for transaction_id: ${data.transaction_id}`);
        res.sendStatus(200);
    });
});

// Handle payment (start-location)
app.post('/create_payment_amount', (req, res) => {
    const data = req.body;
    const status = 'en cours';
    const sql = `INSERT INTO payments(transaction_id, amount_reserved, status) VALUES(?, ?, ?)`;

    paymentsDB.run(sql, [data.transaction_id, data.amount_reserved / 100, status], function(err) {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        console.log(`Payment was added to the table: ${this.lastID}`);
        res.sendStatus(200);
    });
});

// Handle cups return (end-location)
app.post('/returned_cup', (req, res) => {
    console.log("///End location");
    const cup_ids = req.body.cup_list;
    const status = 'rendu';
    const select_sql = `SELECT status FROM cups WHERE cup_id = ?`;

    cup_ids.forEach(cup_id => {
        cupsDB.get(select_sql, [cup_id], (err, row) => {
            if (err) {
                console.error(err.message);
                return;
            }
            if (row && row.status === status) {
                console.log(`Cup_id ${cup_id} a déjà été rendu`);
            } else if (row && row.status === 'en cours') {
                const update_sql = `UPDATE cups SET status = ? WHERE cup_id = ?`;
                cupsDB.run(update_sql, [status, cup_id], function(err) {
                    if (err) {
                        console.error(err.message);
                        return;
                    }
                    console.log(`Le statut de cup_id ${cup_id} est devenu : 'rendu'`);
                });
            } else if (row) {
                console.log(`Cup_id ${cup_id} is not in 'en cours' status`);
            } else {
                console.log(`Cup_id ${cup_id} n'est pas en circulation`);
            }
        });
    });

    res.sendStatus(200);
});    

// Route pour vider les tables
app.post('/api/clearTable', (req, res) => {
    const sqlCups = 'DELETE FROM cups';
    const sqlPayments = 'DELETE FROM payments';

    cupsDB.run(sqlCups, function(err) {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        console.log(`Rows deleted from cups: ${this.changes}`);
    });

    paymentsDB.run(sqlPayments, function(err) {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        console.log(`Rows deleted from payments: ${this.changes}`);
    });

    res.sendStatus(200);
});

// Route pour obtenir les données de la table 'cups'
app.get('/api/getCupsData', (req, res) => {
    const time = new Date().toLocaleTimeString();
    console.log('Getting cups data...' + time);
    const sql = 'SELECT * FROM cups';
    cupsDB.all(sql, [], (err, rows) => {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        res.json(rows);
    });
});

// Route pour obtenir les données de la table 'payments'
app.get('/api/getPaymentsData', (req, res) => {
    const time = new Date().toLocaleTimeString();
    console.log('Getting payments data...' + time);
    const sql = 'SELECT * FROM payments';
    paymentsDB.all(sql, [], (err, rows) => {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        res.json(rows);
    });
});

app.get('/api/update-payments', async (req, res) => {
    const frais_usage = 60;
    const sql = `SELECT * FROM payments WHERE status = 'en cours'`;
    let total_rendu = 0;
    let total_pris = 0;

    console.log('Updating payments...');

    paymentsDB.all(sql, [], async (err, rows) => {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }

        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];
            const cups_sql = `SELECT * FROM cups WHERE transaction_id = ?`;
            total_rendu = 0;
            total_pris = 0;

            cupsDB.all(cups_sql, [element.transaction_id], (err, cups_rows) => {
                if (err) {
                    console.error(err.message);
                    return;
                }

                for (let j = 0; j < cups_rows.length; j++) {
                    const cup = cups_rows[j];
                    if (cup.status === 'rendu'){
                        total_rendu += 1;
                    } else {
                        const update_cup_sql = `UPDATE cups SET status = 'non rendu' WHERE cup_id = ?`;
                        cupsDB.run(update_cup_sql, [cup.cup_id], function(err) {
                            if (err) {
                                console.error(err.message);
                                return;
                            }
                            console.log(`Cup status updated for id ${cup.id}`);
                        });
                    }
                    total_pris += 1;
                }

                const amount_to_capture = total_rendu * frais_usage + (total_pris - total_rendu) * 200;
                const amount_to_return = total_pris * 200 - amount_to_capture;

                try {
                    console.log('amount_to_capture: ', amount_to_capture);
                    const intent = stripe.paymentIntents.capture(element.transaction_id, {
                        amount_to_capture: amount_to_capture,
                    });

                    const update_sql = `UPDATE payments SET amount_captured = ? , status ='rendu' WHERE transaction_id = ?`;
                    paymentsDB.run(update_sql, [amount_to_capture / 100, element.transaction_id], function(err) {
                        if (err) {
                            console.error(err.message);
                            return;
                        }
                        console.log(`Payment updated for transaction_id ${element.transaction_id}`);
                    });
                } catch (err) {
                    console.error(`Failed to capture payment for transaction_id ${element.transaction_id}: ${err.message}`);
                }
            });
        }

        res.sendStatus(200);
    });
});

// Start the HTTPS server
https.createServer(credentials, app).listen(port, () => {
    console.log(`HTTPS Server listening at https://localhost:${port}`);
});

process.on('SIGINT', () => {
    console.log('Server is shutting down...');

    // Send a message to all connected clients to disconnect
    Object.values(clients).forEach(clientArray => {
        clientArray.forEach(client => {
            client.write('data: {"message": "Server is shutting down, please disconnect."}\n\n');
        });
    });

    // Close the server
    server.close(() => {
        console.log('Server has shut down.');
        process.exit(0);
    });
});
