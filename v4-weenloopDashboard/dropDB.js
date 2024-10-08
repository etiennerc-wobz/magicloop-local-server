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
        DROP TABLE items
    `, (err) => {
        if (err) {
            console.error('Erreur lors de la suppression de la table items:', err.message);
        } else {
            console.log('Table items supprimée avec succès.');
        }
    });

    // Création de la table payments
    db.run(`
        DROP TABLE payments
    `, (err) => {
        if (err) {
            console.error('Erreur lors de la suppression de la table payments:', err.message);
        } else {
            console.log('Table payments supprimée avec succès.');
        }
    });

    // Création de la table fakeItems
    db.run(`
        DROP TABLE fakeItems
    `, (err) => {
        if (err) {
            console.error('Erreur lors de la suppression de la table fakeItems:', err.message);
        } else {
            console.log('Table fakeItems supprimée avec succès.');
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
