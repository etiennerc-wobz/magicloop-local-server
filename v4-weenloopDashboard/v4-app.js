import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import session from 'express-session';
import fs from 'fs';
import yaml from 'js-yaml';

import sqlite3 from "sqlite3";
import {open} from "sqlite";

import AsyncLock from 'async-lock';

const lock = new AsyncLock();
const requestQueue = [];


const app = express();
const now = new Date();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
let hour = String(now.getHours()).padStart(2, '0');
hour = hour - 2;
let minute = String(now.getMinutes()).padStart(2, '0');
minute = minute - 1;
const second = String(now.getSeconds()).padStart(2, '0');
const formattedDate = `${year}-${month}-${day}T${hour}:${minute}:${second}+00:00`;

let lastRefreshDate = formattedDate;

const lastRefreshFile = './public/lastRefresh.yml';
if (fs.existsSync(lastRefreshFile)) {
    const fileContents = fs.readFileSync(lastRefreshFile, 'utf8');
    const data = yaml.load(fileContents);
    lastRefreshDate = data.lastRefresh;
}

// Configuration du moteur de template EJS
app.set('view engine', 'ejs');

// Configuration du dossier des fichiers statiques
app.use(express.static('public'));

// Middleware pour parser les corps de requêtes JSON
app.use(bodyParser.json());

// Configuration de la session
app.use(session({
    secret: 'monsecretrobuste',
    resave: false, saveUninitialized: true, cookie: {secure: false}
}));

//Fonction pour ouvrir la base de données SQLite
const openDb = async () => {
    return open({
        filename: './dashboardData.db',
        driver: sqlite3.Database
    });
};

// Fonction pour vider toutes les lignes de la base de données
const wipeAllDBRows = async () => {
    console.log('*** Wiping all rows from the database ***');
    const db = await openDb();
    await db.exec('DELETE FROM payments');
    await db.exec('DELETE FROM items');
    await db.close();
}

// Fonction pour effectuer le login et stocker le token
async function loginAndGetTokenAndCookie(req) {
    const username = 'etienne_supreme@wobz.com';
    const password = 'password';
    const body = JSON.stringify({username, password});

    try {
        const response = await fetch('http://mosh-back.rag-cloud-bg.hosteur.com/api/login_check', {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        req.session.cookieHeader = response.headers.get('set-cookie');
        req.session.token = data.token;
        return {token: data.token, cookieHeader: req.session.cookieHeader};

    } catch (error) {
        console.error('Erreur lors de la vérification des informations de connexion:', error);
        throw error;
    }
}

// Fonction pour lire les paiements depuis la base de données
async function readPaymentsFromDb() {
    const db = await openDb();
    const payments = await db.all('SELECT * FROM payments');
    await db.close();
    return payments;
}

// Fonction pour effectuer une requête avec réessai en cas de base de données occupée
const withRetry = async (fn, retries = 5, delay = 100) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (error.code === 'SQLITE_BUSY' && i < retries - 1) {
                console.warn(`Database is busy, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
};

// Fonction pour écrire les paiements dans la base de données
async function writePaymentsToDb(payments) {
    const db = await openDb();

    await db.exec('BEGIN TRANSACTION');

    for (const payment of payments) {
        // Check if the payment status is 'terminé'
        const existingPayment = await db.get('SELECT status FROM payments WHERE id = ?', [payment.id]);
        if (existingPayment && existingPayment.status === 'terminé') {
            continue;
        }

        await db.run(`
            INSERT OR
            REPLACE
            INTO payments (id, createdAt, items, amount, status, items_collectes, items_totaux)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [payment.id, payment.createdAt, payment.items, payment.amount, payment.status, payment.items_collectes, payment.items_totaux]);
    }

    await db.exec('COMMIT');
    await db.close();
}

// Fonction pour mettre à jour le nombre d'items collectés dans la base de données
async function updateCollectedCountPaymentToDb(payments) {
    const db = await openDb();

    await db.exec('BEGIN TRANSACTION');

    for (const payment of payments) {
        const existingPayment = await db.get('SELECT status FROM payments WHERE id = ?', [payment.id]);
        if (existingPayment && existingPayment.status === 'terminé') {
            continue;
        }

        await db.run(`
            UPDATE payments
            SET items_collectes = ?,
                status          = ?
            WHERE id = ?
        `, [payment.items_collectes, payment.status, payment.id]);
    }

    await db.exec('COMMIT');
    await db.close();
}

//Fonction pour écrire les items dans la base de données
async function writeItemsToDb(items) {
    const db = await openDb();

    const recordedPayments = await readPaymentsFromDb();
    const finishedPayments = recordedPayments.filter(payment => payment.status === 'terminé');

    let itemDate = new Date();
    itemDate = itemDate.toISOString().slice(0, 19);
    // Début de la transaction
    await db.exec('BEGIN TRANSACTION');

    for (const item of items) {
        if (finishedPayments.some(payment => payment.id === item.payment_id)) {
            continue;
        }

        const itemRecord = await db.get(`
            SELECT id, associationDate, collectionDate
            FROM items
            WHERE id = ?
              AND payment_id = ?
        `, [item.id, item.payment_id]);

        if (itemRecord) {
            if (itemRecord.associationDate === null) {
                await db.run(`
                    INSERT INTO items (id, rfid, status, payment_id, associationDate, collectionDate)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET rfid           = excluded.rfid,
                                                  status         = excluded.status,
                                                  payment_id     = excluded.payment_id,
                                                  associationDate= excluded.associationDate,
                                                  collectionDate = excluded.collectionDate
                `, [item.id, item.details.rfid, item.details.itemStateName, item.payment_id, itemDate, null]);
            } else if (item.details.itemStateName === 'COLLECTED' && itemRecord.collectionDate === null) {
                await db.run(`
                    UPDATE items
                    SET status         = ?,
                        collectionDate = ?
                    WHERE id = ?
                      AND payment_id = ?
                `, [item.details.itemStateName, itemDate, item.id, item.payment_id]);
            }
        } else {
            await db.run(`
                INSERT INTO items (id, rfid, status, payment_id, associationDate, collectionDate)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [item.id, item.details.rfid, item.details.itemStateName, item.payment_id, itemDate, null]);
        }
    }

    // Fin de la transaction
    await db.exec('COMMIT');
    await db.close();
}


// Fonction pour extraire les items depuis la base de données et associer l'ID du paiement
async function extractItemsFromDb() {
    const db = await openDb();
    const payments = await db.all("SELECT id, items, status FROM payments WHERE status != 'terminé' OR status IS NULL");
    await db.close();

    const items = [];
    payments.forEach(payment => {
        const itemIds = payment.items.split(',').filter(id => id.trim() !== '');
        itemIds.forEach(itemId => {
            items.push({id: itemId, payment_id: payment.id});
        });
    });

    return items;
}

// Fonction pour extraire tous les items de la base de données
async function getAllItemsFromDb() {
    const db = await openDb();
    const items = await db.all('SELECT * FROM items');
    await db.close();
    return items;
}

// Fonction pour extraire les paiements via API et les lier aux items
async function fetchPaymentsAndItems(token, cookieHeader, refreshDate = lastRefreshDate, prioritize = false) {
    return new Promise((resolve, reject) => {
        const task = async () => {
            try {
                let allPayments = [];
                let page = 1;
                let hasMoreData = true;


                console.log('Fetching data at date after ', refreshDate, ' ....');
                // Fetch all payments
                while (hasMoreData) {

                    const response = await fetch(`http://mosh-back.rag-cloud-bg.hosteur.com/api/payment_transactions?page=${page}&createdAt%5Bafter%5D=${encodeURIComponent(refreshDate)}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'Cookie': cookieHeader
                        },

                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }

                    const data = await response.json();
                    const pageData = data['hydra:member'].filter(payment => (payment.type === 'PAYMENT' && payment.amount > 0));
                    allPayments = allPayments.concat(pageData);

                    hasMoreData = data['hydra:view'] && data['hydra:view']['hydra:next'] !== undefined;
                    page++;
                }
                console.log('Got a total of ', allPayments.length, ' payments');


                // Lire les paiements déjà enregistrés
                const recordedPayments = await readPaymentsFromDb();
                const recordedPaymentsMap = new Map(recordedPayments.map(p => [p.id, p]));

                // Identifier les nouveaux paiements et les paiements existants avec des mises à jour
                const paymentsToWrite = [];
                allPayments.forEach(payment => {
                    const paymentId = payment['@id'].split('/').pop();
                    const newItems = payment.items.map(item => item.split('/').pop()).join(',');

                    if (recordedPaymentsMap.has(paymentId)) {
                        if (recordedPaymentsMap.get(paymentId).status === 'terminé') {
                            payment.items_collectes = recordedPaymentsMap.get(paymentId).items_collectes;
                            payment.status = 'terminé';
                            return;
                        }
                        // Paiement existant, vérifier si les items ont changé
                        const recordedPayment = recordedPaymentsMap.get(paymentId);
                        const existingItems = recordedPayment.items;
                        if (newItems !== existingItems) {
                            // Conserver les anciens items et ajouter les nouveaux
                            const updatedItemsSet = new Set(existingItems.split(',').concat(newItems.split(',')));
                            const updatedItems = Array.from(updatedItemsSet).join(',');
                            paymentsToWrite.push({
                                id: paymentId,
                                createdAt: payment.createdAt,
                                items: updatedItems,
                                amount: payment.amount
                            });
                        }
                    } else {
                        // Nouveau paiement
                        paymentsToWrite.push({
                            id: paymentId,
                            createdAt: payment.createdAt,
                            items: newItems,
                            amount: payment.amount
                        });
                    }
                });


                // Écrire les paiements mis à jour et les nouveaux paiements dans la base de données
                await writePaymentsToDb(paymentsToWrite);

                // Extraire les items depuis la base de données locale
                const extractedItems = await extractItemsFromDb();

                // Fetch items by IDs
                const allItems = [];
                for (const item of extractedItems) {

                    const response = await fetch(`http://mosh-back.rag-cloud-bg.hosteur.com/api/items/${item.id}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'Cookie': cookieHeader
                        }

                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }


                    const itemDetails = await response.json();
                    allItems.push({
                        id: item.id,
                        details: itemDetails,
                        payment_id: item.payment_id
                    });
                }

                // Écrire les items mis à jour dans la base de données
                await writeItemsToDb(allItems);


                // Déterminer le statut des paiements
                const paymentStatuses = {};
                allPayments.forEach(payment => {
                    if (payment.status === 'terminé') {
                        return;
                    }
                    const paymentId = payment['@id'].split('/').pop();
                    const paymentItems = allItems.filter(item => item.payment_id === paymentId);
                    let status = 'en cours';
                    if (paymentItems.length > 0) {
                        const collectedItems = paymentItems.filter(item => item.details.itemStateName === 'COLLECTED');
                        if (collectedItems > 0) {
                            if (collectedItems === paymentItems.length) {
                                status = 'terminé';
                            } else {
                                status = 'en cours';
                            }
                        }
                    }
                    paymentStatuses[paymentId] = status;
                    payment.status = status;
                });

                // Mettre à jour les paiements avec le statut
                for (const payment of paymentsToWrite) {
                    payment.status = paymentStatuses[payment.id];
                }


                const paymentsToUpdate = [];

                let BDItems = await getAllItemsFromDb();

                for (const payment of allPayments) {
                    if (payment.status === 'terminé') {
                        continue;
                    }
                    if (payment.amount < 0) {
                        continue;
                    }
                    const paymentId = payment['@id'].split('/').pop();
                    const collectedItemsCount = BDItems.filter(item => item.payment_id === paymentId && item.status === 'COLLECTED').length;

                    payment.items_collectes = collectedItemsCount;
                    payment.items_totaux = (payment.amount / 100);


                    if (payment.items_collectes === payment.items_totaux) {
                        payment.status = 'terminé';
                    }
                    paymentsToUpdate.push({
                        id: paymentId,
                        items_collectes: payment.items_collectes,
                        status: payment.status
                    });
                }


                // Mettre à jour le nombre d'items collectés dans la base de données
                await updateCollectedCountPaymentToDb(paymentsToUpdate);
                BDItems = await getAllItemsFromDb();

                const result = {payments: allPayments, items: BDItems};
                resolve(result);
            } catch (error) {
                console.error('Erreur lors de la récupération des données:', error);
                reject(error);
            }
        };
        if (prioritize) {
            requestQueue.unshift(task);
        } else {
            requestQueue.push(task);
        }
        processQueue();
    });
}

//Queue de traitement des tâches (fait pour éviter les erreurs de concurrence)
function processQueue() {

    console.log('Processing queue..., i still have ', requestQueue.length, ' tasks to do');

    if (requestQueue.length === 0) {
        return;
    }
    lock.acquire('fetchLock', async (done) => {
        try {
            const task = requestQueue.shift();
            await task();
        } catch (error) {
            console.error('Error processing task:', error);
        } finally {
            done();
            if (requestQueue.length > 0) {
                processQueue();
            }
        }
    }, (err, ret) => {
        if (err) {
            console.error('Error acquiring lock:', err);
        }
    });
}

// Fonction utilisée pour les statistiques, extrait les données des items
async function fetchItemsData(token, cookieHeader) {
    const response = await fetch(`http://mosh-back.rag-cloud-bg.hosteur.com/api/items?page=1&itemType.name=MAMA%20Item`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Cookie': cookieHeader
        }
    });
    let hasMoreData = true;
    const dataItems = await response.json();
    hasMoreData = dataItems['hydra:view'] && dataItems['hydra:view']['hydra:next'] !== undefined;
    let page = 2;
    while (hasMoreData) {
        const response = await fetch(`http://mosh-back.rag-cloud-bg.hosteur.com/api/items?page=${page}&itemType.name=MAMA%20Item`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Cookie': cookieHeader
            }
        });
        const newDataItems = await response.json();
        dataItems['hydra:member'] = dataItems['hydra:member'].concat(newDataItems['hydra:member']);
        hasMoreData = newDataItems['hydra:view'] && newDataItems['hydra:view']['hydra:next'] !== undefined
        page++;
    }

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    let labels = ['COLLECTED', 'IN_USE', 'STORED'];
    let values = [0, 0, 0];
    let i = 0;
    for (const item of dataItems['hydra:member']) {
        if (item.itemStateName === 'COLLECTED') {
            values[0] += 1;
        } else if (item.itemStateName === 'IN_USE') {
            values[1] += 1;
        } else if (item.itemStateName === 'STORED') {
            values[2] += 1;
        }
    }

    const returnData = {
        labels: labels,
        values: values
    }

    return returnData;
}

// Fonction pour extraire les données des items pour le graphique de ligne
async function fetchItemsDateData() {
    console.log('Fetching items date data..., current time is ', new Date().toISOString());
    const db = await openDb();

    // Fonction pour générer toutes les tranches de 5 minutes de la journée actuelle
    function generateTimeIntervals() {
        const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 7, 0));
        const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), new Date().getUTCDate(), 16, 5));
        const intervals = [];
        let current = start;

        while (current < end) {
            intervals.push(current.toISOString().slice(0, 16)); // Format YYYY-MM-DDTHH:MM
            current = new Date(current.getTime() + 300000); // Ajouter 5 minutes (300000 ms)
        }
        return intervals;
    }

    try {
        const sqlAssociation = `SELECT strftime('%Y-%m-%dT%H:', associationDate) ||
                                       substr('00' || ((strftime('%M', associationDate) / 5) * 5), -2, 2) as interval,
                                       count(*)                                                           as count
                                FROM items
                                GROUP BY interval
                                ORDER BY interval ASC;`;

        const sqlCollection = `SELECT strftime('%Y-%m-%dT%H:', collectionDate) ||
                                      substr('00' || ((strftime('%M', collectionDate) / 5) * 5), -2, 2) as interval,
                                      count(*)                                                          as count
                               FROM items
                               GROUP BY interval
                               ORDER BY interval ASC;`;

        await db.exec('BEGIN TRANSACTION');
        const rowsAssociation = await db.all(sqlAssociation);
        const rowsCollection = await db.all(sqlCollection);
        await db.exec('COMMIT');

        // Générer toutes les tranches de 5 minutes de la période
        const allIntervals = generateTimeIntervals();

        // Créer des dictionnaires avec les données
        const dataDictAssociation = rowsAssociation.reduce((acc, row) => {
            acc[row.interval] = row.count;
            return acc;
        }, {});

        const dataDictCollection = rowsCollection.reduce((acc, row) => {
            acc[row.interval] = row.count;
            return acc;
        }, {});

        // Créer les labels et les valeurs pour le graphique
        const labels = allIntervals.map(interval => interval.slice(11, 16)); // Seulement HH:MM
        const valuesAssociation = allIntervals.map(interval => dataDictAssociation[interval] || 0);
        const valuesCollection = allIntervals.map(interval => dataDictCollection[interval] || 0);

        return {
            labels,
            valuesAssociation,
            valuesCollection
        };
    } catch (err) {
        await db.exec('ROLLBACK');
        console.error('Error fetching items date data:', err);
        throw err;
    } finally {
        await db.close();
    }
}

// Route pour afficher le dashboard
app.get('/db', async (req, res) => {
    try {

        let token = req.session.token;
        if (!token) {
            const loginData = await loginAndGetTokenAndCookie(req);
            token = loginData.token;
        }

        const {payments, items} = {payments: [], items: []};

        res.render('dashboard', {
            payments: payments,
            items: items
        });

    } catch (error) {
        console.error('Erreur lors de la récupération des données:', error);
        if (!res.headersSent) {
            res.status(500).send('Erreur lors de la récupération des données.');
        }
    }
});

// Route pour afficher les statistiques
app.get('/stats', async (req, res) => {


    try {

        let token = req.session.token;
        if (!token) {
            const loginData = await loginAndGetTokenAndCookie(req);
            token = loginData.token;
        }

        const data = {
            labels: ['COLLECTED', 'IN_USE', 'STORED'],
            values: [0, 0, 0],
        };
        res.render('stats', {data});

    } catch (error) {
        console.error('Erreur lors de la récupération des données:', error);
        if (!res.headersSent) {
            res.status(500).send('Erreur lors de la récupération des données.');
        }
    }
});

// Route pour obtenir les stats
app.get('/api/stats', async (req, res) => {

    console.log("API STATS");

    try {
        let token = req.session.token;
        if (!token) {
            const loginData = await loginAndGetTokenAndCookie(req);
            token = loginData.token;
        }

        fetchPaymentsAndItems(token, req.session.cookieHeader, undefined);

        const pieData = await fetchItemsData(token, req.session.cookieHeader);
        const lineData = await fetchItemsDateData();
        const returnObj = {
            pieData: pieData,
            lineData: lineData
        }
        res.json(returnObj);
    } catch (error) {
        console.error('Erreur lors de la récupération des données:', error);
        if (!res.headersSent) {
            res.status(500).send('Erreur lors de la récupération des données.');
        }
    }
});

//Route pour obtenir les données dashboard
app.get('/api/data', async (req, res) => {

    requestQueue.length = 0;

    try {
        let token = req.session.token;
        if (!token) {
            const loginData = await loginAndGetTokenAndCookie(req);
            token = loginData.token;
        }

        const {
            payments,
            items
        } = await fetchPaymentsAndItems(token, req.session.cookieHeader, undefined, true);

        res.json({payments: payments, items: items});

    } catch (error) {
        console.error('Erreur lors de la récupération des données:', error);
        if (!res.headersSent) {
            res.status(500).send('Erreur lors de la récupération des données.');
        }
    }
});

// Route pour rafraîchir les données
app.get('/refresh', async (req, res) => {
    wipeAllDBRows();

    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String((now.getHours()) - 2).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    lastRefreshDate = `${year}-${month}-${day}T${hour}:${minute}:${second}+00:00`;

    // Write the new lastRefreshDate to the lastRefresh.yml file
    const lastRefreshData = {lastRefresh: lastRefreshDate};
    const yamlStr = yaml.dump(lastRefreshData);
    fs.writeFileSync('./public/lastRefresh.yml', yamlStr, 'utf8');

    res.send('New refresh date set to ' + lastRefreshDate);
});

// Lancement du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur en cours d'exécution sur le port ${PORT}`);
    console.log(`http://localhost:${PORT}/db`);
});

