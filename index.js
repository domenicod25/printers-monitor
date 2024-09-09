const snmp = require("net-snmp");
const readline = require("readline");

// Configurazione dell'interfaccia readline
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Chiedi all'utente di inserire l'IP della stampante
rl.question("Inserisci l'IP della stampante: ", (ip) => {
    // Configurazione della sessione SNMP
    const session = snmp.createSession(ip, "public");

    console.log("Richiesta SNMP GET", session);

    // Definizione degli OID che vuoi leggere
    const oids = [
        "1.3.6.1.4.1.2590.1.1.1.5.7.2.1.1", // mltSysTotalCount
        "1.3.6.1.4.1.2590.1.1.1.5.7.2.1.3", // mltSysDuplexCount
        "1.3.6.1.4.1.2590.1.1.1.5.7.2.5.1.1", // mltSysTonerTypeIndex
        "1.3.6.1.4.1.2590.1.1.1.5.7.2.5.1.2", // mltSysTonerType
        "1.3.6.1.4.1.2590.1.1.1.5.7.2.5.1.3"  // mltTonerTypeCount
    ];

    // Funzione per stampare i risultati
    function printResults(varbinds) {
        varbinds.forEach((vb, index) => {
            if (snmp.isVarbindError(vb)) {
                console.error(snmp.varbindError(vb));
            } else {
                console.log(`OID: ${oids[index]}, Value: ${vb.value}`);
            }
        });
    }

    // Invia la richiesta SNMP GET
    session.get(oids, (error, varbinds) => {
        console.log("Risultati SNMP GET:", oids);
        if (error) {
            console.error("Errore SNMP:", error);
        } else {
            printResults(varbinds);
        }
        session.close();
        rl.close();
    });
});