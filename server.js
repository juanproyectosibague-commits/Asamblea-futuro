const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (require('fs').existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Panel de asamblea inicializado. Falta el archivo index.html.');
    }
});

app.listen(PORT, () => {
    console.log(`Servidor de asamblea ejecutándose en puerto ${PORT}`);
});
