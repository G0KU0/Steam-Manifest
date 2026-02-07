require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits, Events 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');
const cheerio = require('cheerio'); 

// --- 1. KONFIGURÁCIÓ ---
const LIMITS = {
    1: 15,       // Rang 1
    2: 30,       // Rang 2
    3: Infinity  // Rang 3
};

// --- 2. WEBSZERVER ---
const app = express();
app.get('/', (req, res) => res.send('Bot fut és készen áll!'));
app.listen(process.env.PORT || 3000);

// --- 3. ADATBÁZIS ---
mongoose.connect(process.env.MONGODB_URI).catch(err => console.error("MongoDB hiba:", err));

const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    rank: { type: Number, default: 1 }, 
    dailyUsage: { type: Number, default: 0 },
    lastDate: { type: String, default: '' } 
});
const UserModel = mongoose.model('User', UserSchema);

const ConfigSchema = new mongoose.Schema({
    allowedChannels: [String],
    logChannelId: { type: String, default: null }
});
const ConfigModel = mongoose.model('Config', ConfigSchema);

// --- 4. FORRÁSOK ---
const RYUU_ALL_FIXES_URL = "https://generator.ryuu.lol/fixes"; 
const RYUU_BASE = "https://generator.ryuu.lol";
const LUATOOLS_URL = "https://files.luatools.work/OnlineFix1/";

const MANIFEST_SOURCES = [
    { name: 'Morrenus', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}?api_key=${process.env.MORRENUS_API_KEY}` },
    { name: 'Ryuu', url: (id) => `http://167.235.229.108/${id}` },
    { name: 'Sushi', url: (id) => `https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/${id}.zip` },
    { name: 'TwentyTwo', url: (id) => `http://masss.pythonanywhere.com/storage?auth=IEOIJE54esfsipoE56GE4&appid=${id}` },
    { name: 'ManifestHub', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
});

// --- 5. SEGÉDFÜGGVÉNYEK ---

async function checkQuota(userId) {
    const today = new Date().toISOString().split('T')[0]; 
    let user = await UserModel.findOne({ userId });

    if (!user) return { allowed: false, error: "❌ Nem vagy hozzáadva a rendszerhez! Kérj engedélyt az admintól." };

    if (user.lastDate !== today) {
        user.dailyUsage = 0;
        user.lastDate = today;
        await user.save();
    }

    const limit = LIMITS[user.rank] || 15;
    if (user.dailyUsage >= limit) {
        return { allowed: false, error: `❌ Elérted a napi limitedet! (${user.dailyUsage}/${limit})` };
    }

    return { allowed: true, user };
}

async function fetchManifestZip(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const url = source.url(id);
            const res = await axios({ method: 'get', url: url, responseType: 'arraybuffer', timeout: 3500 });
            if (res.status === 200) {
                return { data: res.data, source: source.name, url: url }; 
            }
        } catch (e) { continue; }
    }
    return null;
}

async function getFile(url, fileName) {
    try {
        const encodedUrl = encodeURI(url);
        const res = await axios.get(encodedUrl, { 
            responseType: 'arraybuffer', 
            timeout: 60000, 
            maxContentLength: 30 * 1024 * 1024,
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        return { attachment: new AttachmentBuilder(Buffer.from(res.data), { name: fileName }) };
    } catch (e) { 
        if (e.response && e.response.status === 413) return { tooLarge: true };
        return null; 
    }
}

// ÚJ: Okos tisztító függvény
// Eltávolítja a szemetet a névből, hogy könnyebb legyen a keresés
function normalizeString(str) {
    return str.toLowerCase()
        .replace(/['"®™]/g, '') // Védjegyek törlése
        .replace(/[^a-z0-9]/g, ' ') // Minden speciális jel helyett szóköz
        .trim();
}

// --- JAVÍTOTT KERESŐ (OKOS KERESÉSSEL) ---
async function findFixes(appid, gameName) {
    let foundFiles = [];
    
    // 1. A keresett név szavakra bontása
    // Pl: "Forza Horizon 5" -> ["forza", "horizon", "5"]
    const searchWords = normalizeString(gameName).split(/\s+/).filter(w => w.length > 1);

    try {
        // 1. Ryuu Lista Letöltése
        const response = await axios.get(RYUU_ALL_FIXES_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (response.data) {
            const $ = cheerio.load(response.data);
            
            $('.fix-item').each((index, element) => {
                // Megpróbáljuk kinyerni a nevet. Ha nincs .fix-name, akkor a href-ből találjuk ki.
                let name = $(element).find('.fix-name').text().trim();
                const relativeLink = $(element).attr('href');

                // Ha nincs név szöveg, szedjük ki a linkből (pl. /fixes/JatekNeve.zip)
                if (!name && relativeLink) {
                    name = relativeLink.split('/').pop().replace(/%20/g, ' ');
                }

                if (name) {
                    const normalizedFileName = normalizeString(name);

                    // --- OKOS KERESÉS ---
                    // Megnézzük, hogy a keresett szavak közül MINDEGYIK benne van-e a fájl nevében.
                    // Ez sokkal rugalmasabb, mint a sima egyezés.
                    const isMatch = searchWords.every(word => normalizedFileName.includes(word));

                    if (isMatch) {
                        const sizeText = $(element).find('.fix-size').text().trim(); 
                        
                        // Címkék kezelése
                        const rawBadges = $(element).find('.fix-badge').map((i, el) => $(el).text().trim()).get();
                        const formattedBadges = rawBadges.map(badge => {
                            const lower = badge.toLowerCase();
                            if (lower === 'tested') return '✅ **Tested**';
                            if (lower === 'online') return '🌐 **Online**';
                            if (lower === 'bypass') return '🛡️ **Bypass**';
                            if (lower === 'unstable') return '⚠️ **Unstable**';
                            return `🏷️ ${badge}`;
                        }).join(' ');

                        const fullUrl = relativeLink.startsWith('http') ? relativeLink : `${RYUU_BASE}${relativeLink}`;
                        
                        let isTooBig = false;
                        if (sizeText.includes('GB')) isTooBig = true;
                        if (sizeText.includes('MB')) {
                            const sizeNum = parseFloat(sizeText.replace(/[^0-9.]/g, ''));
                            if (sizeNum > 24.5) isTooBig = true;
                        }

                        let type = "Fix";
                        if (formattedBadges.includes('Bypass')) type = "🛡️ Bypass";
                        else if (formattedBadges.includes('Online')) type = "🌐 Online Fix";

                        foundFiles.push({
                            url: fullUrl,
                            name: name.endsWith('.zip') ? name : `${name}.zip`,
                            type: type,
                            badges: formattedBadges,
                            sizeText: sizeText,
                            isTooBig: isTooBig
                        });
                    }
                }
            });
        }
    } catch (e) {
        console.error("Hiba a Ryuu lista beolvasásakor:", e.message);
    }

    // 2. Luatools Keresés (Backup)
    const onlineUrl = `${LUATOOLS_URL}${appid}.zip`;
    try {
        const checkOnline = await axios.head(onlineUrl, { timeout: 1500 }).catch(() => null);
        if (checkOnline && checkOnline.status === 200) {
            if (!foundFiles.some(f => f.url === onlineUrl)) {
                foundFiles.push({ 
                    url: onlineUrl, 
                    name: `OnlineFix_${appid}.zip`, 
                    type: '🌐 Luatools Fix',
                    badges: '🌐 **Online**',
                    sizeText: 'Unknown',
                    isTooBig: false 
                });
            }
        }
    } catch(e) {}
    
    return foundFiles;
}

// --- 6. ESEMÉNYEK ---

client.on(Events.InteractionCreate, async interaction => {
    // Autocomplete
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        if (!focused) return interaction.respond([]);
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        return interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    // ADMIN
    if (interaction.commandName === 'admin') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && interaction.user.id !== process.env.ADMIN_ID) {
            return interaction.reply({ content: "❌ Nincs jogosultságod!", ephemeral: true });
        }
        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();
        
        if (group === 'user') {
            const target = interaction.options.getUser('target');
            if (sub === 'add') {
                const rank = interaction.options.getInteger('rank');
                await UserModel.findOneAndUpdate({ userId: target.id }, { userId: target.id, rank: rank }, { upsert: true, new: true });
                return interaction.reply({ content: `✅ **${target.tag}** hozzáadva! Rang: **${rank}**`, ephemeral: true });
            }
            if (sub === 'remove') {
                await UserModel.findOneAndDelete({ userId: target.id });
                return interaction.reply({ content: `🗑️ **${target.tag}** törölve.`, ephemeral: true });
            }
            if (sub === 'reset') {
                await UserModel.findOneAndUpdate({ userId: target.id }, { dailyUsage: 0 });
                return interaction.reply({ content: `🔄 **${target.tag}** kvótája lenullázva.`, ephemeral: true });
            }
        }
        if (group === 'channel') {
            const targetChannel = interaction.options.getChannel('target') || interaction.channel;
            let config = await ConfigModel.findOne() || await ConfigModel.create({ allowedChannels: [] });
            if (sub === 'add') {
                if (!config.allowedChannels.includes(targetChannel.id)) {
                    config.allowedChannels.push(targetChannel.id);
                    await config.save();
                    return interaction.reply({ content: `✅ Csatorna engedélyezve: ${targetChannel}`, ephemeral: true });
                }
                return interaction.reply({ content: `⚠️ Már engedélyezve van.`, ephemeral: true });
            }
            if (sub === 'remove') {
                config.allowedChannels = config.allowedChannels.filter(id => id !== targetChannel.id);
                await config.save();
                return interaction.reply({ content: `🚫 Csatorna tiltva.`, ephemeral: true });
            }
            if (sub === 'setlog') {
                config.logChannelId = targetChannel.id;
                await config.save();
                return interaction.reply({ content: `📜 Log csatorna beállítva: ${targetChannel}`, ephemeral: true });
            }
        }
    }

    // MANIFEST PARANCS
    if (interaction.commandName === 'manifest') {
        const sub = interaction.options.getSubcommand();
        const appId = sub === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        
        let config = await ConfigModel.findOne();
        if (config && config.allowedChannels.length > 0 && !config.allowedChannels.includes(interaction.channelId)) {
            return interaction.reply({ content: "❌ Rossz csatorna!", ephemeral: true });
        }

        const quota = await checkQuota(interaction.user.id);
        if (!quota.allowed) return interaction.reply({ content: quota.error, ephemeral: true });

        // PRIVÁT VÁLASZ (Ephemeral)
        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId]?.success) return interaction.editReply("❌ Játék nem található a Steamen.");

            const gameData = steamRes.data[appId].data;
            const searchName = gameData.name;
            console.log(`[KERESÉS] ${interaction.user.tag} -> ${searchName}`);

            const foundFiles = await findFixes(appId, searchName); 
            const zip = await fetchManifestZip(appId);
            
            let attachments = [];
            let statusText = "";

            // 1. MANIFEST
            if (zip) {
                if (zip.data.length > 10 * 1024 * 1024) { 
                    const sizeMB = (zip.data.length / 1024 / 1024).toFixed(1);
                    statusText += `⚠️ **Manifest:** Túl nagy (${sizeMB} MB) -> [Letöltés](${zip.url})\n`;
                } else {
                    attachments.push(new AttachmentBuilder(Buffer.from(zip.data), { name: `manifest_${appId}.zip` }));
                    statusText += `✅ **Manifest:** Fájl csatolva (${zip.source})\n`;
                }
            } else {
                statusText += `❌ **Manifest:** Nincs találat.\n`;
            }

            // 2. JAVÍTÁSOK LISTÁZÁSA
            if (foundFiles.length > 0) {
                statusText += `\n**🛠️ Talált Fájlok (${foundFiles.length} db):**\n`;
                
                for (const fix of foundFiles) {
                    const badgeLine = fix.badges ? `${fix.badges}` : ""; 
                    const sizeInfo = fix.sizeText ? `| 📏 \`${fix.sizeText}\`` : "";

                    if (fix.isTooBig) {
                        statusText += `⚠️ **${fix.name}**\n${badgeLine} ${sizeInfo}\n🔗 **Túl nagy:** [Letöltés](${encodeURI(fix.url)})\n\n`;
                        continue;
                    }

                    const fileData = await getFile(fix.url, fix.name);
                    
                    if (fileData?.attachment) {
                        attachments.push(fileData.attachment);
                        statusText += `✅ **${fix.name}**\n${badgeLine} ${sizeInfo}\n\n`;
                    } else {
                        statusText += `🔗 **${fix.name}**\n${badgeLine} ${sizeInfo}\n[Letöltés](${encodeURI(fix.url)}) (Hiba)\n\n`;
                    }
                }
            } else {
                statusText += `❌ **Javítás:** Nem található fájl a listában.\n`;
            }

            // KVÓTA
            quota.user.dailyUsage += 1;
            await quota.user.save();
            const remaining = LIMITS[quota.user.rank] === Infinity ? "∞" : LIMITS[quota.user.rank] - quota.user.dailyUsage;
            const quotaText = `Használva: ${quota.user.dailyUsage} | Maradt: ${remaining}`;

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(foundFiles.length > 0 || zip ? 0x00FF00 : 0xFF0000)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Állapot', value: statusText },
                    { name: 'Napi Kvóta', value: quotaText }
                )
                .setFooter({ text: "SteamTools Master" });

            // 3. KÜLDÉS
            try {
                await interaction.editReply({ embeds: [embed], files: attachments });
            } catch (sendError) {
                console.log("Küldési hiba (túl nagy csomag), váltás Link módra.");
                
                let fallbackText = "";
                if (zip) fallbackText += `🔗 **Manifest:** [LETÖLTÉS](${zip.url})\n`;
                
                for (const fix of foundFiles) {
                    fallbackText += `🔗 **${fix.name}:** [LETÖLTÉS](${encodeURI(fix.url)}) - ${fix.badges}\n`;
                }
                
                const fallbackEmbed = new EmbedBuilder()
                    .setTitle(`📦 ${gameData.name} (Link Mód)`)
                    .setDescription(`⚠️ **A csomag mérete meghaladta a Discord limitet.**\nTöltsd le innen:\n\n${fallbackText}`)
                    .addFields({ name: 'Napi Kvóta', value: quotaText })
                    .setThumbnail(gameData.header_image)
                    .setColor(0xFFA500);

                await interaction.editReply({ embeds: [fallbackEmbed], files: [] });
            }

            // 4. LOG (Ez marad nyilvános a log csatornán, ha be van állítva)
            if (config && config.logChannelId) {
                try {
                    const logChannel = await client.channels.fetch(config.logChannelId);
                    if (logChannel) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle("📜 Sikeres Lekérés")
                            .setColor(0x3498db)
                            .setThumbnail(gameData.header_image)
                            .addFields(
                                { name: 'User', value: `${interaction.user.tag}`, inline: true },
                                { name: 'Játék', value: `${gameData.name}`, inline: true },
                                { name: 'Fájlok', value: `${foundFiles.length} db + Manifest`, inline: true }
                            )
                            .setTimestamp();
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                } catch (e) {}
            }

        } catch (e) {
            console.error(e);
            await interaction.editReply({ content: "❌ Váratlan hiba történt.", files: [] });
        }
    }
});

// --- 7. START ---
client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('Játék letöltése')
            .addSubcommand(sub => sub.setName('id').setDescription('AppID alapján').addStringOption(o => o.setName('appid').setDescription('AppID').setRequired(true)).addBooleanOption(o => o.setName('dlc').setDescription('DLC?')))
            .addSubcommand(sub => sub.setName('nev').setDescription('Név alapján').addStringOption(o => o.setName('jateknev').setDescription('Név').setRequired(true).setAutocomplete(true)).addBooleanOption(o => o.setName('dlc').setDescription('DLC?'))),
        new SlashCommandBuilder()
            .setName('admin')
            .setDescription('Bot kezelése')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommandGroup(group => group.setName('user').setDescription('Felhasználók')
                .addSubcommand(sub => sub.setName('add').setDescription('Hozzáadás').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)).addIntegerOption(o => o.setName('rank').setDescription('Rang').setRequired(true).addChoices({ name: 'Rang 1', value: 1 }, { name: 'Rang 2', value: 2 }, { name: 'Rang 3', value: 3 })))
                .addSubcommand(sub => sub.setName('remove').setDescription('Törlés').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)))
                .addSubcommand(sub => sub.setName('reset').setDescription('Kvóta nullázása').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true))))
            .addSubcommandGroup(group => group.setName('channel').setDescription('Csatornák')
                .addSubcommand(sub => sub.setName('add').setDescription('Engedélyezés').addChannelOption(o => o.setName('target').setDescription('Csatorna')))
                .addSubcommand(sub => sub.setName('remove').setDescription('Tiltás').addChannelOption(o => o.setName('target').setDescription('Csatorna')))
                .addSubcommand(sub => sub.setName('setlog').setDescription('Log csatorna').addChannelOption(o => o.setName('target').setDescription('Csatorna').setRequired(true))))
    ].map(c => c.toJSON());
    const clientId = process.env.CLIENT_ID || client.user.id;
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`✅ Bot online: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
