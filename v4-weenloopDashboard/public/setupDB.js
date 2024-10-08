// setupDb.js
import sqlite3 from 'sqlite3';
import {open} from 'sqlite';

const initializeDatabase = async () => {
    const db = await open({
        filename: './payments.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS payments
        (
            id            TEXT PRIMARY KEY,
            validatedAt   TEXT,
            items         TEXT
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS items
        (
            id         INTEGER,
            rfid       TEXT,
            status     TEXT,
            payment_id TEXT,
            PRIMARY KEY (id, payment_id)
        );
    `);


    console.log('Database initialized');
    await db.close();
};

initializeDatabase().catch(err => console.error('Failed to initialize database:', err));
