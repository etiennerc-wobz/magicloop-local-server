import sqlite3 from "sqlite3";

// Ouverture de la base de données
let db = new sqlite3.Database('./dashboardData.db', (err) => {
    if (err) {
        console.error('Erreur lors de l\'ouverture de la base de données:', err.message);
    } else {
        console.log('Connecté à la base de données SQLite.');
    }
});

// Création des tables
db.serialize(() => {
    // Création de la table items
    db.run(`
        CREATE TABLE IF NOT EXISTS items
        (
            id              INTEGER,
            rfid            TEXT,
            status          TEXT,
            payment_id      TEXT,
            itemTypeCode    TEXT,
            associationDate TEXT,
            collectionDate  TEXT,
            PRIMARY KEY (id, payment_id)
        )
    `, (err) => {
        if (err) {
            console.error('Erreur lors de la création de la table items:', err.message);
        } else {
            console.log('Table items créée avec succès.');
        }
    });

    // Création de la table payments
    db.run(`
        CREATE TABLE IF NOT EXISTS payments
        (
            id              TEXT PRIMARY KEY,
            validatedAt     TEXT,
            items           TEXT,
            status          TEXT,
            amount          TEXT,
            items_totaux    TEXT,
            items_collectes TEXT,
            payment_type    TEXT
        )
    `, (err) => {
        if (err) {
            console.error('Erreur lors de la création de la table payments:', err.message);
        } else {
            console.log('Table payments créée avec succès.');
        }
    });

    // Création de la table fakeItems
    db.run(`
        CREATE TABLE IF NOT EXISTS fakeItems
        (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            associationDate TEXT,
            collectionDate  TEXT
        )
    `, (err) => {
        if (err) {
            console.error('Erreur lors de la création de la table fakeItems:', err.message);
        } else {
            console.log('Table fakeItems créée avec succès.');
        }
    });
});

// Fermeture de la base de données
db.close((err) => {
    if (err) {
        console.error('Erreur lors de la fermeture de la base de données:', err.message);
    } else {
        console.log('Connexion à la base de données SQLite fermée.');
    }
});
