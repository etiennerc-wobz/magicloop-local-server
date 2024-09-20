import sqlite3 from 'sqlite3';
import fs from 'fs';
import csv from 'csv-parser';

// Ouvrir la base de données SQLite
let db = new sqlite3.Database('../dashboardData.db', (err) => {
    if (err) {
        console.error('Erreur lors de l\'ouverture de la base de données:', err.message);
    } else {
        console.log('Connecté à la base de données SQLite.');
    }
});

// Fonction pour vider la table fakeItems
function clearTable(callback) {
    db.run('DELETE FROM fakeItems', (err) => {
        if (err) {
            console.error('Erreur lors de la suppression des données:', err.message);
        } else {
            console.log('Table fakeItems vidée.');
            callback();
        }
    });
}

// Fonction pour insérer des données dans la table fakeItems
function insertData(data, callback) {
    db.serialize(() => {
        const stmt = db.prepare('INSERT INTO fakeItems (associationDate, collectionDate) VALUES (?, ?)');
        data.forEach(row => {
            stmt.run(row['collectionDate'] || null, row['associationDate'] || null, (err) => {
                if (err) {
                    console.error('Erreur lors de l\'insertion des données:', err.message);
                }
            });
        });
        stmt.finalize(callback);
    });
}

// Lire et analyser le fichier CSV
const data = [];
fs.createReadStream('./fakeItems.csv')
    .pipe(csv({
        headers: ['id', 'collectionDate', 'associationDate'],
        skipLines: 0
    }))
    .on('data', (row) => {
        console.log('Ligne lue:', row);
        data.push(row);
    })
    .on('end', () => {
        console.log('Fichier CSV traité avec succès');

        // Vider la table avant d'insérer les nouvelles données
        clearTable(() => {
            insertData(data, () => {
                console.log('Insertion des données terminée.');

                // Fermer la base de données après l'insertion
                db.close((err) => {
                    if (err) {
                        console.error('Erreur lors de la fermeture de la base de données:', err.message);
                    } else {
                        console.log('Connexion à la base de données SQLite fermée.');
                    }
                });
            });
        });
    });
