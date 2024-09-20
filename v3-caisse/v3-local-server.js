const express = require('express');
const path = require('path');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = 80;
const http = require('http');
const { time } = require('console');
const send = require('send');
const stripe = require('stripe')('sk_test_51KNzhNBx3mhjsHyvVriXOtqBIweE5k9FVjQRhfWyA1kG5Ca0tATKlAfbmNZt9wlPgMGtA02Kb01IZ0qZ6wbYYY3j00KqGxYJoG');
const endpointSecret = 'whsec_a370327d3ecc554eb5a0c94dca74ad755ed900962b776366817f636c4e9bc298';

// Databases setup
const cupsDB = new sqlite3.Database('./cups.db');
const paymentsDB = new sqlite3.Database('./payments.db');

//For the payment refund (v3 only)
let current_commande = {};

// SSE clients storage
let clients = {
    transaction1: [],
    transaction2: [],
    transaction3: []
};

//terminal_id for the stripe terminal
const terminal_id = 'tmr_FgzH8wQUOswPF5'

app.post('/stripe_webhooks', express.raw({ type: 'application/json' }), (request, response) => {
    let event = request.body;
    // Only verify the event if you have an endpoint secret defined.
    // Otherwise use the basic event deserialized with JSON.parse
    if (endpointSecret) {
        // Get the signature sent by Stripe
        const signature = request.headers['stripe-signature'];
        try {
            event = stripe.webhooks.constructEvent(
                request.body,
                signature,
                endpointSecret
            );
        } catch (err) {
            console.log(`⚠️  Webhook signature verification failed.`, err.message);
            return response.sendStatus(400);
        }
    }

    // Handle the event
    switch (event.type) {
        case 'payment_intent.succeeded':
            const PI = event.data.object;
            console.log(`PaymentIntent for ${PI.id} succedded!`);

            //Update paymentsDB table
            const sql = `UPDATE payments SET status = ? WHERE transaction_id = ?`;
            paymentsDB.run(sql, ['payé', PI.id], function (err) {
                if (err) {
                    console.error(err.message);
                    return;
                }
                console.log(`Payment was updated to 'à payer' for transaction_id: ${PI.id}`);
            }
            );

            sendOrderToClients(current_commande, clients.transaction1, PI.id);

            break;

        default:
            // Unexpected event type
            console.log(`Unhandled event type ${event.type}.`);
    }

    // Return a 200 response to acknowledge receipt of the event
    response.send();
});

// Middleware setup
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));
app.use(cors());

// Create the HTTP server
const server = http.createServer(app);



// Utility functions
function sendOrderToClients(data, clients, pi_id) {
    console.log('Sending order to clients:', data);
    const order = [
        { name: "Gobelet", quantity: parseInt(data[0]) + parseInt(data[1]) + parseInt(data[2]) },
        { name: "Blonde Ninkasi 50cl", quantity: parseInt(data[0]) },
        { name: "Brune Ninkasi 50cl", quantity: parseInt(data[1]) },
        { name: "Coca-Coca Light 50cl", quantity: parseInt(data[2]) }
    ].filter(item => item.quantity !== 0);

    const dataObj = { transaction_id: pi_id, order };
    const jsonData = JSON.stringify(dataObj);

    console.log('Trying to send order to clients:', jsonData);

    clients.forEach(clientRes => {
        console.log("Sending:", jsonData);
        clientRes.write(`data: ${jsonData}\n\n`);
    });
}

function calculateOrderAmount(data) {
    const prices = { blonde: 6, brune: 6, coca: 3 };
    const deposit = 2;

    let total = 0;

    data.forEach(item => {
        quantity = item[0]
        drink = item.slice(1);
        console.log('Drink:', drink, 'Quantity:', quantity);
        total += prices[drink] * quantity + deposit * quantity;
    });

    return total;
}


async function handleOrderRequest(req, res, clients) {
    console.log('Received a POST request');
    const data = req.body.data.split('-');
    console.log('Data:', data);

    current_commande = data;

    const totalAmount = calculateOrderAmount(data);
    console.log('Total amount:', totalAmount);

    const paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmount * 100,
        currency: 'eur',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
    });

    const reader = await stripe.terminal.readers.processPaymentIntent(
        terminal_id,
        {
            payment_intent: paymentIntent.id,
        }
    );

    let sql = `INSERT INTO payments(transaction_id, amount_reserved, status) VALUES(?, ?, ?)`;
    let params = [paymentIntent.id, totalAmount, 'à payer'];

    paymentsDB.run(sql, params, function (err) {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        console.log(`Payment was added to the table: ${this.lastID}`);
    });

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
app.post('/get-transaction1', (req, res) => handleOrderRequest(req, res, clients.transaction1));
app.post('/get-transaction2', (req, res) => handleOrderRequest(req, res, clients.transaction2));
app.post('/get-transaction3', (req, res) => handleOrderRequest(req, res, clients.transaction3));

// GET routes for SSE
app.get('/get-transaction1', (req, res) => handleSSERequest(req, res, 'transaction1'));
app.get('/get-transaction2', (req, res) => handleSSERequest(req, res, 'transaction2'));
app.get('/get-transaction3', (req, res) => handleSSERequest(req, res, 'transaction3'));

// Serve the main interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'v3-interfaceOrder.html'));
});

// Serve the database interface
app.get('/db', (req, res) => {
    res.sendFile(path.join(__dirname, 'databasePage.html'));
});


// Handle cups rental (start-location)
app.post('/link_payment_to_cup', (req, res) => {
    const data = req.body;
    const status = 'en utilisation';
    const select_sql = `SELECT cup_id FROM cups WHERE cup_id = ?`;
    const insert_sql = `INSERT INTO cups(transaction_id, cup_id, status) VALUES(?, ?, ?)`;
    const update_sql = `UPDATE payments SET status = ? WHERE transaction_id = ?`;
    const check_transaction_sql = `SELECT transaction_id FROM payments WHERE transaction_id = ?`;
    let cup_ids = req.body.cup_list

    paymentsDB.get(check_transaction_sql, [data.transaction_id], (err, row) => {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        if (!row) {
            console.log(`transaction_id ${data.transaction_id} does not exist in payments database`);
            res.sendStatus(400);
            return;
        }

        try {
            cup_ids.forEach(cup_id => {
                cupsDB.get(select_sql, [cup_id], (err, row) => {
                    if (err) {
                        console.error(err.message);
                        res.sendStatus(500);
                        return;
                    }
                    if (row) {
                        console.log(`cup_id ${cup_id} is already in use`);
                        res.sendStatus(500);
                    } else {
                        cupsDB.run(insert_sql, [data.transaction_id, cup_id, status], function (err) {
                            if (err) {
                                console.error(err.message);
                                res.sendStatus(500);
                                return;
                            }
                            console.log(`Cup was added to the table: ${this.lastID}`);

                            paymentsDB.run(update_sql, ['payé, en utilisation', data.transaction_id], function (err) {
                                if (err) {
                                    console.error(err.message);
                                    res.sendStatus(500);
                                    return;
                                }
                                console.log(`Payment status was updated for transaction_id: ${data.transaction_id}`);
                                res.sendStatus(200);
                            });
                        });
                    }
                });
            });
        } catch (err) {
            console.error(`Error processing cup_id_list: ${err.message}`);
            res.sendStatus(500);
            return;
        }

    });
});


// Handle payment (start-location)
app.post('/create_payment_amount', (req, res) => {
    const data = req.body;
    const status = 'en cours';
    const sql = `INSERT INTO payments(transaction_id, amount_reserved,status) VALUES(?, ?,?)`;

    paymentsDB.run(sql, [data.transaction_id, data.amount_reserved / 100, status], function (err) {
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
            } else if (row && row.status === 'en utilisation') {
                const update_sql = `UPDATE cups SET status = ? WHERE cup_id = ?`;
                cupsDB.run(update_sql, [status, cup_id], function (err) {
                    if (err) {
                        console.error(err.message);
                        return;
                    }
                    console.log(`Le statut de cup_id ${cup_id} est devenu : 'rendu'`);
                });
            } else if (row) {
                console.log(`Cup_id ${cup_id} is not in 'en utilisation' status`);
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

    cupsDB.run(sqlCups, function (err) {
        if (err) {
            console.error(err.message);
            res.sendStatus(500);
            return;
        }
        console.log(`Rows deleted from cups: ${this.changes}`);
    });

    paymentsDB.run(sqlPayments, function (err) {
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
    const sql = `SELECT * FROM payments WHERE status = 'payé, en utilisation'`;
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


            cupsDB.all(cups_sql, [element.transaction_id], async (err, cups_rows) => {
                total_rendu = 0;
                total_pris = 0;
                if (err) {
                    console.error(err.message);
                    return;
                }

                for (let j = 0; j < cups_rows.length; j++) {
                    const cup = cups_rows[j];
                    if (cup.status === 'rendu') {
                        total_rendu += 1;
                    } else {
                        const update_cup_sql = `UPDATE cups SET status = 'non rendu' WHERE cup_id = ?`;
                        cupsDB.run(update_cup_sql, [cup.cup_id], function (err) {
                            if (err) {
                                console.error(err.message);
                                return;
                            }
                            console.log(`Cup status updated for id ${cup.id}`);
                        });
                    }
                    total_pris += 1;
                }

                const amount_to_return = total_rendu * (200 - frais_usage);
                console.log(`Transaction_id: ${element.transaction_id} - Total rendu: ${total_rendu} - Total pris: ${total_pris} - Amount to return: ${amount_to_return}`);
                try {
                    if (amount_to_return > 0) {
                        const refund = await stripe.refunds.create({
                            payment_intent: element.transaction_id,
                            amount: amount_to_return,
                        });
                    }
                    else {
                        console.log(`Refund for transaction_id ${element.transaction_id} is ZERO`);
                    }

                } catch (err) {
                    console.error(`Failed to return transaction_id ${element.transaction_id}: ${err.message}`);
                }
                const update_sql = `UPDATE payments SET amount_captured = ? , status ='remboursé' WHERE transaction_id = ?`;
                paymentsDB.run(update_sql, [amount_to_return, element.transaction_id], function (err) {
                    if (err) {
                        console.error(err.message);
                        return;
                    }
                    console.log(`Payment updated for transaction_id ${element.transaction_id}`);
                });
            });
        }

        res.sendStatus(200);
    });
});



// Start the server
server.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
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


