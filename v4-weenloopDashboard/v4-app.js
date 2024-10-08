import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import session from 'express-session';
import fs from 'fs';
import yaml from 'js-yaml';

import sqlite3 from "sqlite3";
import {open} from "sqlite";

import AsyncLock from 'async-lock';

import paginate from 'paginate'; //instead of const express = require('express');

const paginator = paginate();

const lock = new AsyncLock();
const requestQueue = [];

const availableOptions = ['itemTypes', 'paymentTypes', 'rangeTime', 'iotTypes'];
const defaultItemTypes = ['MG33IML', 'MG50STICKER'];
const defaultPaymentTypes = ['CB', 'CASHLESS'];
const defaultIotTypes = ['30', '31'];
const defaultRange = {startTime: '00:00', endTime: '24:00'};
const defaultOption = {
    'itemTypes': defaultItemTypes,
    'paymentTypes': defaultPaymentTypes,
    'iotTypes': defaultIotTypes,
    'rangeTime': defaultRange,
};
const STORED_INDEX = 0;
const IN_USE_INDEX = 1;
const COLLECTED_INDEX = 2;

// Change env file to use another API and/or set API user credentials
const apiHost = process.env.API_URL;
const apiUsername = process.env.API_USERNAME;
const apiPassword = process.env.API_PASSWORD;
const apiItems = `${apiHost}/items`;
const apiLoginCheck = `${apiHost}/login_check`;
const apiPaymentTransactions = `${apiHost}/payment_transactions`

let selectedItemTypes = defaultItemTypes;
let selectedPaymentTypes = defaultPaymentTypes;
let selectedIotTypes = defaultIotTypes;

const maxItemsPerPage = 25;

/**
 * Includes result from fetchPaymentsAndResults
 * Model:
 *      {
 *          payments: array,
 *          paymentItems: array,
 *          items: array,
 *          pagination: Object
 *      }
 */
let fetchPaymentsAndItemsResult = {};

const MINUTE_IN_SECONDS = 60;
const SECOND_IN_MILLISECONDS = 1000;

const TIME_BEFORE_UPDATE = 5 * SECOND_IN_MILLISECONDS;

const app = express();
const now = new Date();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
let hour = String(now.getHours()).padStart(2, '0');
hour = hour - 2; // JBO : To ensure to be the day before or... ? Why - 2 ?
let minute = String(now.getMinutes()).padStart(2, '0');
minute = minute - 1; // JBO : To ensure to be the day before or... ? Why - 1 ?
const second = String(now.getSeconds()).padStart(2, '0');
const formattedDate = `${year}-${month}-${day}T${hour}:${minute}:${second}+00:00`;


const transactionType = {
    payment: 'PAYMENT',
    refund: 'REFUND'
}

let lastRefreshDate = formattedDate;
let db;

// PAGINATION
let itemsPerPage = 25; // Default items per page
let totalItems = 0; // Default total items
let page = 1; // Default page

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
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(bodyParser.json());

// Configuration de la session
app.use(session({
    secret: 'monsecretrobuste',
    resave: false, saveUninitialized: true, cookie: {secure: false}
}));

let openDb = async () => {
    if (!db) {
        await connectDb();
    }
    return db;
};

//Fonction pour ouvrir la base de données SQLite
const connectDb = async () => {
    db = await open({
        filename: './dashboardData.db',
        driver: sqlite3.Database
    });
};

// Fonction pour vider toutes les lignes de la base de données
const wipeAllDBRows = async () => {
    console.log('*** Wiping all rows from the database ***');
    db = await openDb();
    await db.exec('DELETE FROM payments');
    await db.exec('DELETE FROM items');
}

/**
 * 
 * @param {string} time Time must be formatted like HH:MM
 * @returns A float conversion of time (i.e. 8:30 => 8.5)
 */
function convertTimeToFloat(time) {
    if(typeof time !== 'string') {
        return time;
    }
    const hours = parseInt(time.split(':').shift()) % 24;
    const minutes = parseInt(time.split(':').pop()) % 60;
    return (hours + (minutes / MINUTE_IN_SECONDS));
}

function buildGetParameterFromArray(array, parameterName) {
    let value;
    let getParameterArray = [];
    for (value of array) {
        getParameterArray.push(encodeURI(parameterName + "[]=" + value));
    }
    return getParameterArray.join('&');
}

// Fonction pour effectuer le login et stocker le token
async function loginAndGetTokenAndCookie(req) {
    const body = JSON.stringify({username: apiUsername, password: apiPassword});

    try {
        const response = await fetch(apiLoginCheck, {
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
    db = await openDb();
    const payments = await db.all('SELECT * FROM payments');
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

function getIdFromIRI (iri) {
    return iri.split('/').pop()
}

// Fonction pour écrire les paiements dans la base de données
async function writePaymentsToDb(payments) {
    db = await openDb();

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
            INTO payments (id, validatedAt, items, amount, status, items_collectes, items_totaux, payment_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [payment.id, payment.validatedAt, payment.items, payment.amount, payment.status, payment.items_collectes, payment.items_totaux, payment.payment_type]);
    }

    await db.exec('COMMIT');
}

// Fonction pour mettre à jour le nombre d'items collectés dans la base de données
async function updateCollectedCountPaymentToDb(payments) {
    db = await openDb();

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
}

//Fonction pour écrire les items dans la base de données
async function writeItemsToDb(items) {
    db = await openDb();

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
                                                  collectionDate = excluded.collectionDate,
                                                  itemTypeCode   = excluded.itemTypeCode
                `, [item.id, item.rfid, item.itemStateName, item.payment_id, itemDate, null]);
            } else if (item.itemStateName === 'COLLECTED' && itemRecord.collectionDate === null) {
                await db.run(`
                    UPDATE items
                    SET status         = ?,
                        collectionDate = ?
                    WHERE id = ?
                      AND payment_id = ?
                `, [item.itemStateName, itemDate, item.id, item.payment_id]);
            }
        } else {
            await db.run(`
                INSERT INTO items (id, rfid, status, payment_id, associationDate, collectionDate, itemTypeCode)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [item.id, item.rfid, item.itemStateName, item.payment_id, itemDate, null, item.itemTypeCode]);
        }
    }

    // Fin de la transaction
    await db.exec('COMMIT');
}

// Fonction pour extraire les items depuis la base de données et associer l'ID du paiement
async function extractItemsFromDb() {
    db = await openDb();
    // const payments = await db.all("SELECT id, items, status FROM payments WHERE status != 'terminé' OR status IS NULL");
    const payments = await db.all("SELECT id, items, status FROM payments");

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
    db = await openDb();
    const items = await db.all('SELECT * FROM items');
    return items;
}

app.get('/api/refreshDate', async (req, res) => {
    res.json(lastRefreshDate);
});

// Fonction pour extraire les paiements via API et les lier aux items
async function fetchPaymentsAndItems(
    token,
    cookieHeader,
    page = null,
    refreshDate = lastRefreshDate,
    prioritize = false,
    options = {}
) {
    availableOptions.forEach(function (element) {
        if (! Object.hasOwn(options, element) || options[element] == null || options[element].length === 0) {
            options[element] = defaultOption[element];
        }
    });
    return new Promise((resolve, reject) => {
        const task = async () => {
            try {
                let maxPage = null;
                let paymentsToWrite = [];

                // Lire les paiements déjà enregistrés
                const recordedPayments = await readPaymentsFromDb();
                const recordedPaymentsMap = new Map(recordedPayments.map(p => [p.id, p]));
                let allPayments = [];

                if (page === null) {
                    page = 1;
                }
                else {
                    maxPage = page;
                }
                
                do {
                    let pagePayments = [];
                    
                    let url = `${apiPaymentTransactions}` +
                        `?page=${page}` +
                        `&itemsPerPage=${itemsPerPage}` +
                        `&transactionType.type=${transactionType.payment}` +
                        `&validatedAt%5Bafter%5D=${encodeURIComponent(refreshDate)}` +
                        `&amount%5Bgt%5D=0` +
                        `&order%validatedAt%5D=desc` + 
                        `&order%5BtransactionId%5D=asc`
                    ;
    
                    const response = await fetch(url, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'Cookie': cookieHeader
                        },
                    });
    
                    if (! response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
    
                    const data = await response.json();
                    pagePayments = data['hydra:member'];
                    totalItems = data['hydra:totalItems'];
                    if (! maxPage) {
                        if('hydra:last' in data['hydra:view']) {
                            maxPage = data['hydra:view']['hydra:last'].split('=').pop();
                        }
                        else {
                            maxPage = page;
                        }
                    }
                    
                    // Identifier les nouveaux paiements et les paiements existants avec des mises à jour
                    pagePayments.forEach(payment => {
                        const paymentId = getIdFromIRI(payment['@id']);
                        let newItems = payment.items.map(item => getIdFromIRI(item)).join(',');
    
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
                                    validatedAt: payment.validatedAt,
                                    items: updatedItems,
                                    amount: payment.amount,
                                    payment_type: payment.paymentMedia
                                });
                            }
                        } else {
                            // Nouveau paiement
                            paymentsToWrite.push({
                                id: paymentId,
                                validatedAt: payment.validatedAt,
                                items: newItems,
                                amount: payment.amount,
                                payment_type: payment.paymentMedia
                            });
                        }
                    });
                    page ++;
                    allPayments = allPayments.concat(pagePayments);
                }
                while(page <= maxPage);
            
                // Écrire les paiements mis à jour et les nouveaux paiements dans la base de données
                await writePaymentsToDb(paymentsToWrite);

                // Extraire les items depuis la base de données locale
                const extractedItems = await extractItemsFromDb();
                let paymentIds = allPayments.map(payment => getIdFromIRI(payment['@id']));

                // Fetch items by IDs
                let allItems = [];
                let itemIds = [];
                let itemPaymentId = {};
                for (const item of extractedItems) {
                    itemIds.push(item.id);
                    itemPaymentId[item.id] = item.payment_id;
                }
                const getParameter = itemIds.join(`&id%5B%5D=`);
                let customItemPage = 1;
                let getParameterWithPagination = getParameter + `&page=${customItemPage}&itemsPerPage=${maxItemsPerPage}`;
                let dataItems;

                if(itemIds.length > 0) {
                    const response = await fetch(`${apiItems}?&id%5B%5D=${getParameterWithPagination}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'Cookie': cookieHeader
                        }
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }

                    dataItems = await response.json();
                }

                if (dataItems && dataItems['hydra:member'] && dataItems['hydra:member'] !== undefined) {
                    allItems = dataItems['hydra:member'];
                }

                let hasMoreData = dataItems && dataItems['hydra:view'] && dataItems['hydra:view']['hydra:next'] !== undefined;
                while (hasMoreData) {
                    customItemPage ++;
                    getParameterWithPagination = getParameter + `&page=${customItemPage}&itemsPerPage=${maxItemsPerPage}`;
                    const response = await fetch(`${apiItems}?&id%5B%5D=${getParameterWithPagination}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'Cookie': cookieHeader
                        }
                    });
                    let newDataItems = await response.json();
                    allItems = allItems.concat(newDataItems['hydra:member']);
                    hasMoreData = newDataItems['hydra:view'] && newDataItems['hydra:view']['hydra:next'] !== undefined
                }

                if(allItems && allItems.length > 0) {
                    allItems = allItems.map(function (item) {
                        const itemId = parseInt(getIdFromIRI(item['@id']));
                        return {
                            ...item, 
                            id: itemId,
                            payment_id: itemPaymentId[itemId] ?? null
                        };
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
                    const paymentId = getIdFromIRI(payment['@id']);
                    const paymentItems = allItems.filter(item => item.payment_id === paymentId);
                    let status = 'en cours';
                    if (paymentItems.length > 0) {
                        const collectedItems = paymentItems.filter(item => item.itemStateName === 'COLLECTED');
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
                    const paymentId = getIdFromIRI(payment['@id']);
                    const collectedItemsCount = BDItems.filter(item => item.payment_id === paymentId && item.status === 'COLLECTED').length;

                    payment.items_collectes = collectedItemsCount;

                    if (payment.items_collectes === payment.nbOfItems) {
                        payment.status = 'terminé';
                    }

                    paymentsToUpdate.push({
                        id: paymentId,
                        items_collectes: payment.items_collectes,
                        items_totaux: payment.nbOfItems,
                        status: payment.status
                    });
                }


                // Mettre à jour le nombre d'items collectés dans la base de données
                await updateCollectedCountPaymentToDb(paymentsToUpdate);

                // On filtre les items liés à un paiement
                let paymentItems = allItems.filter(item => paymentIds.includes(item.payment_id));

                BDItems = await getAllItemsFromDb();

                // Manage pagination
                let paymentsPagination = paginator.page(totalItems, itemsPerPage, page);
                
                // Custom trick because isCurrent may be incoherent
                if(paymentsPagination.pages[page - 1] !== undefined) {
                    paymentsPagination.pages[page - 1].isCurrent = true;
                }

                let optionFilter = {withUTCOffset: false};

                // On applique les filtres pour renvoyer uniquement les paiements de la recherche
                for (let optionName in options) {
                    [allPayments, paymentItems] = applyFilter(optionName, options[optionName], allPayments, paymentItems, optionFilter);
                }

                fetchPaymentsAndItemsResult = {payments: allPayments, paymentItems: paymentItems, items: BDItems, pagination: paymentsPagination};
                resolve(fetchPaymentsAndItemsResult);
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

function applyFilter (optionName, selectedOptions, payments, items, options = {}) {
    let utcOffset;
    if (Object.hasOwn(options, 'withUTCOffset')) {
        utcOffset = options.withUTCOffset;
    }
    else {
        utcOffset = true; // default
    }
    switch (optionName) {
        case 'paymentTypes':
            payments = payments.filter(function(payment) {
                return selectedOptions.includes(payment.paymentMedia)
            });
            break;
        case 'rangeTime':
            const startTimeFloat = convertTimeToFloat(selectedOptions.startTime);
            const endTimeFloat = convertTimeToFloat(selectedOptions.endTime);
            let timezoneOffset = utcOffset ? new Date().getTimezoneOffset() / 60 : 0;
            payments = payments.filter(payment =>
                payment.validatedAtTime && 
                (startTimeFloat === 0 || payment.validatedAtTime >= startTimeFloat + timezoneOffset) && 
                (endTimeFloat === 0 || payment.validatedAtTime <= endTimeFloat + timezoneOffset)
            );
            break;
        case 'itemTypes':
            items = items.filter(item => selectedOptions.includes(item.itemTypeCode));
            break;
    }
    return [payments, items];
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
            if(task) {
                await task();
            }
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
    let itemTypeGetParameter = buildGetParameterFromArray(selectedItemTypes, 'itemType.code');
    let paymentTypesGetParameter = buildGetParameterFromArray(selectedPaymentTypes, 'paymentMedia');
    let url = '';
    
    // We just want the hydra totalItems so 0 is fine
    url = `${apiItems}?itemsPerPage=0`;
    if (itemTypeGetParameter !== '') {
        url += '&' + itemTypeGetParameter;
    }

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Cookie': cookieHeader
        }
    });

    const dataItems = await response.json();
    const totalItemsCount = dataItems['hydra:totalItems'];
    let page = 1;
    let maxPage = null;
    let payments = [];

    // Now we fetch by payment to filter paymentTypes
    do {
        let pagePayments = [];
        
        let url = `${apiPaymentTransactions}` +
            `?page=${page}` +
            `&itemsPerPage=${maxItemsPerPage}` +
            `&transactionType.type=${transactionType.payment}` +
            `&validatedAt%5Bafter%5D=${encodeURIComponent(lastRefreshDate)}` +
            `&amount%5Bgt%5D=0` +
            `&order%validatedAt%5D=desc` + 
            `&order%5BtransactionId%5D=asc`
        ;

        if (paymentTypesGetParameter !== '') {
            url += '&' + paymentTypesGetParameter;
        }

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Cookie': cookieHeader
            },
        });

        if (! response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        pagePayments = data['hydra:member'];
        if (! maxPage) {
            if('hydra:last' in data['hydra:view']) {
                maxPage = data['hydra:view']['hydra:last'].split('=').pop();
            }
            else {
                maxPage = page;
            }
        }

        page ++;
        payments = payments.concat(pagePayments);
    }
    while(page <= maxPage);
    let paymentItems = [];
    payments.forEach(payment => paymentItems.push(...payment.allItems));
    paymentItems = paymentItems.map(paymentItem => paymentItem.itemId);
    let filteredPaymentItems = [...new Set(paymentItems)];

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    let labels = ['STORED', 'IN_USE', 'COLLECTED'];
    let values = [0, 0, 0, 0, 0];
    let total_in_use = 0;
    let total_collected = 0;

    for (const item of fetchPaymentsAndItemsResult.paymentItems) {
        if (item.itemStateName === 'COLLECTED') {
            total_collected ++;
            if (filteredPaymentItems.includes(item.id)) {
                values[COLLECTED_INDEX] ++;
            }
        } else if (item.itemStateName === 'IN_USE') {
            total_in_use ++;
            if (filteredPaymentItems.includes(item.id)) {
                values[IN_USE_INDEX] ++;
            }
        }
    }

    values[STORED_INDEX] = totalItemsCount - total_collected - total_in_use;
    if (values[STORED_INDEX] < 0) {
        values[STORED_INDEX] = 0;
    }

    return {
        labels: labels,
        values: values
    };
}

// Fonction pour extraire les données des items pour le graphique de ligne
async function fetchItemsDateData() {
    console.log('Fetching items date data..., current time is ', new Date().toISOString());
    db = await openDb();

    // Fonction pour générer toutes les tranches de 5 minutes de la journée actuelle
    function generateTimeIntervals() {
        const startUTC = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 0, 0));
        const endUTC = new Date(Date.UTC(startUTC.getUTCFullYear(), startUTC.getUTCMonth(), new Date().getUTCDate(), 0, 0));

        const start = new Date(new Date().setHours(0, 0, 0, 0));
        const end = new Date(new Date().setHours(0, 0, 0, 0));

        end.setDate(end.getDate() + 1);
        endUTC.setDate(endUTC.getDate() + 1);
        const intervals = [];
        const intervalsUTC = [];
        let current = start;

        while (current < end) {
            intervals.push(current.toISOString().slice(0, 16)); // Format YYYY-MM-DDTHH:MM
            current = new Date(current.getTime() + 5 * MINUTE_IN_SECONDS * SECOND_IN_MILLISECONDS);
        }
        let currentUTC = startUTC;

        while (currentUTC < endUTC) {
            intervalsUTC.push(currentUTC.toISOString().slice(0, 16)); // Format YYYY-MM-DDTHH:MM
            currentUTC = new Date(currentUTC.getTime() + 5 * MINUTE_IN_SECONDS * SECOND_IN_MILLISECONDS);
        }
        return {data: intervals, label: intervalsUTC};
    }

    try {
        const paymentTypesPlaceHolder = selectedPaymentTypes.map(() => '?').join(',');
        const itemTypesPlaceHolder = selectedItemTypes.map(() => '?').join(',');
        const sqlAssociation = `SELECT strftime('%Y-%m-%dT%H:', associationDate) ||
                                       substr('00' || ((strftime('%M', associationDate) / 5) * 5), -2, 2) as interval,
                                       count(*)                                                           as count
                                FROM (
                                    SELECT items.*
                                    FROM items, payments
                                    WHERE items.payment_id = payments.id
                                    AND items.itemTypeCode IN (${itemTypesPlaceHolder})
                                    AND payments.payment_type IN (${paymentTypesPlaceHolder})
                                )
                                GROUP BY interval
                                ORDER BY interval ASC;`;

        const sqlCollection = `SELECT strftime('%Y-%m-%dT%H:', collectionDate) ||
                                      substr('00' || ((strftime('%M', collectionDate) / 5) * 5), -2, 2) as interval,
                                      count(*)                                                          as count
                               FROM (
                                    SELECT items.*
                                    FROM items, payments
                                    WHERE items.payment_id = payments.id
                                    AND items.itemTypeCode IN (${itemTypesPlaceHolder})
                                    AND payments.payment_type IN (${paymentTypesPlaceHolder})
                                )
                               GROUP BY interval
                               ORDER BY interval ASC;`;

        await db.exec('BEGIN TRANSACTION');
        const rowsAssociation = await db.all(sqlAssociation, ...selectedItemTypes, ...selectedPaymentTypes);
        const rowsCollection = await db.all(sqlCollection, ...selectedItemTypes, ...selectedPaymentTypes);
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
        const labels = allIntervals.label.map(interval => interval.slice(11, 16)); // Seulement HH:MM
        const valuesAssociation = allIntervals.data.map(interval => dataDictAssociation[interval] || 0);
        const valuesCollection = allIntervals.data.map(interval => dataDictCollection[interval] || 0);

        return {
            labels,
            valuesAssociation,
            valuesCollection
        };
    } catch (err) {
        try {
            await db.exec('ROLLBACK');
        } catch (err) {

        } finally {
            console.error('Error fetching items date data:', err);
            throw err;
        }
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

        if (req.query.page) {
            page = req.query.page;
        }

        res.render('dashboard');

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
            labels: ['STORED', 'IN_USE', 'COLLECTED'],
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

/** Route pour obtenir les statistiques.
 *  Paramètres de requête POST :
 *      - array selectedItemTypes Type d'objets sélectionnés (vide = tous)
 *      - array selectedPaymentTypes Type de paiements sélectionnés (vide = tous)
 *      - array selectedIotTypes Type d'IOT sélectionnés (vide = tous) : pas utilisé pour le moment
 */
app.post('/api/stats', async (req, res) => {
    try {
        selectedItemTypes = req.body.selectedItemTypes.map((itemType) => itemType.id);
        selectedItemTypes = selectedItemTypes.length === 0 ? defaultItemTypes : selectedItemTypes;

        selectedPaymentTypes = req.body.selectedPaymentTypes.map((paymentType) => paymentType.id);
        selectedPaymentTypes = selectedPaymentTypes.length === 0 ? defaultPaymentTypes : selectedPaymentTypes;

        selectedIotTypes = req.body.selectedIotTypes.map((iotType) => iotType.id);
        selectedIotTypes = selectedIotTypes.length === 0 ? defaultIotTypes : selectedIotTypes;

        const options = {itemTypes: selectedItemTypes, paymentTypes: selectedPaymentTypes, iotTypes: selectedIotTypes};

        let token = req.session.token;
        if (!token) {
            const loginData = await loginAndGetTokenAndCookie(req);
            token = loginData.token;
        }
        const {
            payments,
            items,
            pagination
        } = await fetchPaymentsAndItems(token, req.session.cookieHeader, null, undefined, true, options);
        
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

/**
 *  Route pour obtenir les données dashboard
 */
app.post('/api/data', async (req, res) => {
    requestQueue.length = 0;

    try {
        const itemTypes = req.body.selectedItemTypes.map((itemType) => itemType.id);
        const paymentTypes = req.body.selectedPaymentTypes.map((paymentType) => paymentType.id);
        const startTime = convertTimeToFloat(req.body.startTime);
        const endTime = convertTimeToFloat(req.body.endTime);

        let token = req.session.token;
        if (!token) {
            const loginData = await loginAndGetTokenAndCookie(req);
            token = loginData.token;
        }

        const options = {itemTypes, paymentTypes, rangeTime: {startTime, endTime}};
        const {
            payments,
            items,
            pagination
        } = await fetchPaymentsAndItems(token, req.session.cookieHeader, null, undefined, true, options);

        res.json({payments: payments, items: items, pagination: pagination.render({baseUrl: '/db' })});

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

