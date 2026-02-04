require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- RENDER.COM ÉLETBEN TARTÁS ---
const app = express();
app.get('/', (req, res) => res.send('Manifest Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- MONGODB ADATMODELL ---
mongoose.connect(process.env.MONGODB_URI);
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

// --- FORRÁSOK ---
const MANIFEST_SOURCES = [
    { name: 'ManifestHub (Primary)', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` },
    { name: 'ManifestHub (Mirror)', url: (id) => `https://codeload.github.com/Steam-Manifests/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Pointy-Hat Store', url: (id) => `https://codeload.github.com/Pointy-Hat/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Steam-Archive', url: (id) => `https://codeload.github.com/Steam-Manifests-Archive/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Depot-Mirror', url: (id) => `https://codeload.github.com/Manifest-Database/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

// --- SLASH PARANCSOK ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése (Összes DLC)')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Letöltés AppID alapján')
                .addStringOption(o => o.setName('appid').setDescription('AppID').setRequired(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC keresése?')))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(o => o.setName('jateknev').setDescription('Játék neve').setRequired(true).setAutocomplete(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC keresése?'))),
    
    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Admin beállítások')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók')
                .addSubcommand(sub => sub.setName('add').setDescription('Hozzáadás').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Eltávolítás').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('Lista')))
        .addSubcommandGroup(group =>
            group.setName('channel')
                .setDescription('Csatornák')
                .addSubcommand(sub => sub.setName('add').setDescription('Engedélyezés').addChannelOption(o => o.setName('channel').setDescription('Csatorna').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Tiltás').addChannelOption(o => o.setName('channel').setDescription('Csatorna').setRequired(true))))
].map(c => c.toJSON());

// --- SEGÉDFÜGGVÉNYEK ---

async function getManifestWithFallback(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const res = await axios({ method: 'get', url: source.url(id), responseType: 'arraybuffer', timeout: 4000 });
            if (res.status === 200) return { data: res.data, source: source.name, id: id };
        } catch (e) { continue; }
    }
    return null;
}

// Segédfüggvény a fájlok darabolásához (max 10 fájl/üzenet)
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// --- ESEMÉNYEK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ ${client.user.tag} online!`);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        const focusedValue = interaction.options.getFocused();
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focusedValue)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        await interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: '❌ Nincs jogod!', ephemeral: true });
        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();
        const target = interaction.options.getUser('target') || interaction.options.getChannel('channel');

        if (group === 'user') {
            if (sub === 'add') { if (!db.allowedUsers.includes(target.id)) db.allowedUsers.push(target.id); }
            if (sub === 'remove') db.allowedUsers = db.allowedUsers.filter(id => id !== target.id);
            if (sub === 'list') return interaction.reply({ content: `Tagok: ${db.allowedUsers.map(id => `<@${id}>`).join(', ')}`, ephemeral: true });
        }
        if (group === 'channel') {
            if (sub === 'add') { if (!db.allowedChannels.includes(target.id)) db.allowedChannels.push(target.id); }
            if (sub === 'remove') db.allowedChannels = db.allowedChannels.filter(id => id !== target.id);
        }
        await db.save();
        return interaction.reply({ content: '✅ Beállítások mentve!', ephemeral: true });
    }

    if (interaction.commandName === 'manifest') {
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) return interaction.reply({ content: '❌ Itt nem használhatod!', ephemeral: true });
        if (!db.allowedUsers.includes(interaction.user.id)) return interaction.reply({ content: '❌ Nincs jogod!', ephemeral: true });

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') || false;

        await interaction.deferReply({ ephemeral: true });

        let allFiles = [];
        let logLines = [];

        // 1. Alapjáték
        const main = await getManifestWithFallback(appId);
        if (main) {
            allFiles.push(new AttachmentBuilder(Buffer.from(main.data), { name: `base_${appId}.zip` }));
            logLines.push(`✅ **Alapjáték (${appId})**`);
        } else {
            logLines.push(`❌ **Alapjáték (${appId})** - Nem található.`);
        }

        // 2. DLC-k letöltése (Nincs limit!)
        if (includeDlc) {
            const dlcData = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`).catch(() => null);
            const dlcs = dlcData?.data[appId]?.data?.dlc || [];

            if (dlcs.length > 0) {
                logLines.push(`\n**DLC-k keresése (${dlcs.length} db)...**`);
                for (const dlcId of dlcs) {
                    const dlcFile = await getManifestWithFallback(dlcId);
                    if (dlcFile) {
                        allFiles.push(new AttachmentBuilder(Buffer.from(dlcFile.data), { name: `dlc_${dlcId}.zip` }));
                    }
                }
                logLines.push(`✅ Talált DLC manifestek: ${allFiles.length - (main ? 1 : 0)} db`);
            }
        }

        if (allFiles.length === 0) return interaction.editReply('❌ Nem találtam semmit.');

        // 3. Küldés 10-esével (Batching)
        const chunks = chunkArray(allFiles, 10);
        
        for (let i = 0; i < chunks.length; i++) {
            const embed = new EmbedBuilder()
                .setTitle(i === 0 ? '📦 Steam Manifest Csomag' : `📦 További DLC-k (${i + 1}/${chunks.length})`)
                .setColor(0x00aeef)
                .setDescription(i === 0 ? logLines.join('\n') : 'A maradék kért DLC manifestek alább csatolva.');

            if (i === 0) {
                await interaction.editReply({ embeds: [embed], files: chunks[i] });
            } else {
                await interaction.followUp({ embeds: [embed], files: chunks[i], ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
