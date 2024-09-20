import sqlite3

# Connect to the database
conn = sqlite3.connect('payments.db')

# Create a cursor
c = conn.cursor()

# Update column
c.execute('''
    UPDATE payments
    SET amount_reserved = amount_reserved / 100
''')

# Commit the changes and close the connection
conn.commit()
conn.close()