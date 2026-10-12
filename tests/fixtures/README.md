Реальные ответы официального сайта, полученные 12 октября 2026 года:

- `calendar.html`: неизменённый блок `__NUXT_DATA__` из https://pfc-cska.com/ru/matchi/kalendar-matchej/ (остальная HTML-разметка удалена).
- `upcoming.json`: https://api.pfc-cska.com/site/listing/matches?parent=82&season_id=223981&lang=ru
- `results.json`: https://api.pfc-cska.com/site/listing/matches?lang=ru&parent=82&season_id=223981&is_finished=true
- `training.json`: https://api.pfc-cska.com/site/listing/matches?lang=ru&parent=82&season_id=223980&is_finished=true
- `1992.json`: https://api.pfc-cska.com/site/listing/matches?lang=ru&parent=82&season_id=29551&is_finished=true

Числовой `is_finished=1` сайт игнорирует; используется строка `true`.
Поля результатов и расписания в файлах сохранены без изменений.
